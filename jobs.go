package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type jobSummary struct {
	ID        string `json:"id"`
	Action    string `json:"action"`
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Completed int    `json:"completed"`
	Succeeded int    `json:"succeeded"`
	Failed    int    `json:"failed"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type jobResult struct {
	ServerID int64  `json:"server_id"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	OK       bool   `json:"ok"`
	Message  string `json:"message"`
	Backup   string `json:"backup,omitempty"`
}

type jobDetail struct {
	jobSummary
	Results []jobResult `json:"results"`
}

func initializeJobStore(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			action TEXT NOT NULL,
			status TEXT NOT NULL,
			total INTEGER NOT NULL,
			completed INTEGER NOT NULL DEFAULT 0,
			succeeded INTEGER NOT NULL DEFAULT 0,
			failed INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS job_items (
			job_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			server_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL,
			ok INTEGER NOT NULL DEFAULT 0,
			message TEXT NOT NULL DEFAULT '',
			backup TEXT NOT NULL DEFAULT '',
			PRIMARY KEY(job_id, position)
		);
		CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
		CREATE INDEX IF NOT EXISTS idx_job_items_job_id ON job_items(job_id);
	`); err != nil {
		return err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := db.Exec(`
		UPDATE job_items
		SET status='interrupted', ok=0,
		    message=CASE WHEN message='' THEN 'controller restarted before completion' ELSE message END
		WHERE status IN ('queued','running')
	`); err != nil {
		return err
	}
	_, err := db.Exec(`
		UPDATE jobs
		SET status='interrupted',
		    failed=failed+(total-completed),
		    completed=total,
		    updated_at=?
		WHERE status IN ('queued','running')
	`, now)
	return err
}

func (a *app) createJob(p preview) (jobSummary, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	job := jobSummary{
		ID:        randomID(),
		Action:    p.Request.Action,
		Status:    "queued",
		Total:     len(p.Changes),
		CreatedAt: now,
		UpdatedAt: now,
	}
	tx, err := a.db.Begin()
	if err != nil {
		return jobSummary{}, err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		INSERT INTO jobs(id,action,status,total,completed,succeeded,failed,created_at,updated_at)
		VALUES(?,?,?,?,0,0,0,?,?)
	`, job.ID, job.Action, job.Status, job.Total, job.CreatedAt, job.UpdatedAt); err != nil {
		return jobSummary{}, err
	}
	for i, c := range p.Changes {
		if _, err := tx.Exec(`
			INSERT INTO job_items(job_id,position,server_id,name,status,ok,message,backup)
			VALUES(?,?,?,?, 'queued',0,'','')
		`, job.ID, i, c.ServerID, c.ServerName); err != nil {
			return jobSummary{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return jobSummary{}, err
	}
	return job, nil
}

func (a *app) runJob(p preview, jobID string) {
	now := time.Now().UTC().Format(time.RFC3339)
	_, _ = a.db.Exec(`UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status='queued'`, now, jobID)

	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for position, c := range p.Changes {
		wg.Add(1)
		go func(position int, c change) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			_, _ = a.db.Exec(`
				UPDATE job_items SET status='running'
				WHERE job_id=? AND position=? AND status='queued'
			`, jobID, position)

			o := a.executeChange(context.Background(), p, c)
			status := "failed"
			successInc, failedInc := 0, 1
			if o.OK {
				status = "succeeded"
				successInc, failedInc = 1, 0
			}
			now := time.Now().UTC().Format(time.RFC3339)
			_, _ = a.db.Exec(`
				UPDATE job_items
				SET status=?,ok=?,message=?,backup=?
				WHERE job_id=? AND position=?
			`, status, boolInt(o.OK), o.Message, o.Backup, jobID, position)
			_, _ = a.db.Exec(`
				UPDATE jobs
				SET completed=completed+1,
				    succeeded=succeeded+?,
				    failed=failed+?,
				    updated_at=?
				WHERE id=?
			`, successInc, failedInc, now, jobID)
		}(position, c)
	}
	wg.Wait()
	_, _ = a.db.Exec(`
		UPDATE jobs SET status='completed',updated_at=?
		WHERE id=? AND status='running'
	`, time.Now().UTC().Format(time.RFC3339), jobID)
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (a *app) executeChange(parent context.Context, p preview, c change) outcome {
	o := outcome{ServerID: c.ServerID, Name: c.ServerName}
	if c.Error != "" {
		o.Message = c.Error
		return o
	}
	s, e := a.getServer(c.ServerID)
	if e != nil {
		o.Message = "server was removed"
		return o
	}
	if s.Name != c.ServerName || serverFingerprint(s) != c.ServerFingerprint {
		o.Message = "server changed since preview"
		return o
	}

	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()

	switch c.Action {
	case "backup":
		o.Backup, e = a.backup(ctx, s)
	case "restartSb":
		e = a.suiPost(ctx, s, "restartSb", url.Values{})
	case "inbound_patch":
		obj, err := a.suiGet(ctx, s, "inbounds")
		if err != nil {
			e = err
			break
		}
		inbound, err := inboundByTag(obj, p.Request.InboundTag)
		if err != nil {
			e = err
			break
		}
		current, _ := json.Marshal(inbound)
		if fingerprint(current) != c.Fingerprint {
			e = errors.New("inbound changed after preview; preview again")
			break
		}
		o.Backup, e = a.backup(ctx, s)
		if e != nil {
			break
		}
		e = a.suiPost(ctx, s, "save", url.Values{"object": {"inbounds"}, "action": {"edit"}, "data": {string(c.After)}})
		if e == nil {
			e = a.verifySaved(ctx, s, c, p.Request)
		}
	case "client_enable", "client_disable", "client_create":
		if c.Action != "client_create" {
			obj, err := a.suiGet(ctx, s, "clients")
			if err != nil {
				e = err
				break
			}
			client, err := clientByName(obj, p.Request.ClientName)
			if err != nil {
				e = err
				break
			}
			current, _ := json.Marshal(client)
			if fingerprint(current) != c.Fingerprint {
				e = errors.New("client changed after preview; preview again")
				break
			}
		} else {
			obj, err := a.suiGet(ctx, s, "clients")
			if err != nil {
				e = err
				break
			}
			var newClient map[string]any
			if err := json.Unmarshal(c.After, &newClient); err != nil {
				e = errors.New("invalid client preview payload")
				break
			}
			for _, client := range objectList(obj, "clients") {
				if client["name"] == newClient["name"] {
					e = errors.New("client created after preview; preview again")
					break
				}
			}
			if e != nil {
				break
			}
			known, err := a.suiGet(ctx, s, "inbounds")
			if err != nil {
				e = err
				break
			}
			available := map[int]bool{}
			for _, inbound := range objectList(known, "inbounds") {
				if id, ok := inbound["id"].(float64); ok {
					available[int(id)] = true
				}
			}
			rawInbounds, ok := newClient["inbounds"].([]any)
			if !ok {
				e = errors.New("invalid client inbound list")
				break
			}
			for _, rawID := range rawInbounds {
				id, ok := rawID.(float64)
				if !ok || !available[int(id)] {
					e = errors.New("inbound changed after preview; preview again")
					break
				}
			}
			if e != nil {
				break
			}
		}
		o.Backup, e = a.backup(ctx, s)
		if e != nil {
			break
		}
		action := "edit"
		if c.Action == "client_create" {
			action = "new"
		}
		e = a.suiPost(ctx, s, "save", url.Values{"object": {"clients"}, "action": {action}, "data": {string(c.After)}})
		if e == nil {
			e = a.verifySaved(ctx, s, c, p.Request)
		}
	case "inbound_create", "outbound_create", "outbound_patch", "route_rule_add", "route_rule_replace", "route_rule_delete":
		o.Backup, e = executeExtended(ctx, a, s, c, p.Request)
	case "config_save":
		o.Backup, e = executeConfigSave(ctx, a, s, c, p.Request)
	case "rule_set_apply":
		o.Backup, e = executeRuleSetApplication(ctx, a, s, c)
	default:
		e = errors.New("unsupported action")
	}

	o.OK = e == nil
	if e != nil {
		o.Message = e.Error()
	} else {
		o.Message = "completed"
	}
	_, _ = a.db.Exec(`
		INSERT INTO audit(at,action,server_id,ok,detail) VALUES(?,?,?,?,?)
	`, time.Now().UTC().Format(time.RFC3339), c.Action, c.ServerID, o.OK, o.Message)
	return o
}

func (a *app) jobsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rows, err := a.db.Query(`
		SELECT id,action,status,total,completed,succeeded,failed,created_at,updated_at
		FROM jobs ORDER BY created_at DESC LIMIT 30
	`)
	if err != nil {
		apiError(w, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	items := []jobSummary{}
	for rows.Next() {
		var item jobSummary
		if err := rows.Scan(&item.ID, &item.Action, &item.Status, &item.Total, &item.Completed, &item.Succeeded, &item.Failed, &item.CreatedAt, &item.UpdatedAt); err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		apiError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) jobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/jobs/"), "/")
	if id == "" || strings.Contains(id, "/") || len(id) > 80 {
		apiError(w, http.StatusBadRequest, errors.New("invalid job ID"))
		return
	}

	var detail jobDetail
	err := a.db.QueryRow(`
		SELECT id,action,status,total,completed,succeeded,failed,created_at,updated_at
		FROM jobs WHERE id=?
	`, id).Scan(&detail.ID, &detail.Action, &detail.Status, &detail.Total, &detail.Completed, &detail.Succeeded, &detail.Failed, &detail.CreatedAt, &detail.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		apiError(w, http.StatusNotFound, errors.New("job not found"))
		return
	}
	if err != nil {
		apiError(w, http.StatusInternalServerError, err)
		return
	}

	rows, err := a.db.Query(`
		SELECT server_id,name,status,ok,message,backup
		FROM job_items WHERE job_id=? ORDER BY position
	`, id)
	if err != nil {
		apiError(w, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	detail.Results = []jobResult{}
	for rows.Next() {
		var item jobResult
		var ok int
		if err := rows.Scan(&item.ServerID, &item.Name, &item.Status, &ok, &item.Message, &item.Backup); err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		item.OK = ok == 1
		detail.Results = append(detail.Results, item)
	}
	if err := rows.Err(); err != nil {
		apiError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}
