package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBatchExecuteRunsAsPersistentJob(t *testing.T) {
	a := testApp(t)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/app/apiv2/getdb":
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 128)...))
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()

	id1 := addTestServer(t, a, panel.URL)
	id2 := addTestServer(t, a, panel.URL)
	w := postJSON(t, a.previewHandler, "/api/operations/preview", previewRequest{
		ServerIDs: []int64{id1, id2},
		Action:    "backup",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	}
	var p preview
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Changes) != 2 {
		t.Fatalf("expected 2 changes, got %d", len(p.Changes))
	}

	w = postJSON(t, a.executeHandler, "/api/operations/execute", map[string]string{"preview_id": p.ID})
	if w.Code != http.StatusAccepted {
		t.Fatalf("execute should start job: %d %s", w.Code, w.Body.String())
	}
	var started jobSummary
	if err := json.Unmarshal(w.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.ID == "" || started.Status != "queued" || started.Total != 2 {
		t.Fatalf("unexpected started job: %+v", started)
	}

	var detail jobDetail
	deadline := time.Now().Add(5 * time.Second)
	for {
		req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+started.ID, nil)
		w = httptest.NewRecorder()
		a.jobHandler(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("job status: %d %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
			t.Fatal(err)
		}
		if detail.Status == "completed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not complete: %+v", detail)
		}
		time.Sleep(20 * time.Millisecond)
	}

	if detail.Completed != 2 || detail.Succeeded != 2 || detail.Failed != 0 {
		t.Fatalf("unexpected counters: %+v", detail)
	}
	if len(detail.Results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(detail.Results))
	}
	for _, result := range detail.Results {
		if !result.OK || result.Status != "succeeded" || result.Backup == "" {
			t.Fatalf("unexpected result: %+v", result)
		}
	}

	w = httptest.NewRecorder()
	a.jobsHandler(w, httptest.NewRequest(http.MethodGet, "/api/jobs", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), started.ID) {
		t.Fatalf("jobs list: %d %s", w.Code, w.Body.String())
	}
}

func TestInitializeJobStoreMarksUnfinishedJobsInterrupted(t *testing.T) {
	a := testApp(t)
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := a.db.Exec(`
		INSERT INTO jobs(id,action,status,total,completed,succeeded,failed,created_at,updated_at)
		VALUES('unfinished','backup','running',2,1,1,0,?,?)
	`, now, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.db.Exec(`
		INSERT INTO job_items(job_id,position,server_id,name,status,ok,message,backup)
		VALUES('unfinished',0,1,'one','succeeded',1,'completed','one.db'),
		      ('unfinished',1,2,'two','running',0,'','')
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := initializeJobStore(a.db); err != nil {
		t.Fatal(err)
	}

	var status string
	var completed, failed int
	if err := a.db.QueryRow(`SELECT status,completed,failed FROM jobs WHERE id='unfinished'`).Scan(&status, &completed, &failed); err != nil {
		t.Fatal(err)
	}
	if status != "interrupted" || completed != 2 || failed != 1 {
		t.Fatalf("unexpected interrupted job state: status=%s completed=%d failed=%d", status, completed, failed)
	}
	var itemStatus, message string
	if err := a.db.QueryRow(`SELECT status,message FROM job_items WHERE job_id='unfinished' AND position=1`).Scan(&itemStatus, &message); err != nil {
		t.Fatal(err)
	}
	if itemStatus != "interrupted" || !strings.Contains(message, "restarted") {
		t.Fatalf("unexpected interrupted item: %s %q", itemStatus, message)
	}
}
