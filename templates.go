package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var templateTagPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}$`)

type savedTemplate struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

type templateInput struct {
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

func initializeTemplateStore(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS templates (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		payload_cipher TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		deleted_at TEXT
	);
	CREATE UNIQUE INDEX IF NOT EXISTS templates_active_name ON templates(kind, name) WHERE deleted_at IS NULL;`)
	return err
}

func validateTemplate(input *templateInput) error {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 100 {
		return errors.New("template name must be 1 to 100 characters")
	}
	if len(input.Payload) == 0 || len(input.Payload) > 256<<10 {
		return errors.New("template payload must be 1 to 256 KiB")
	}
	if !json.Valid(input.Payload) {
		return errors.New("invalid template payload")
	}
	if input.Kind == "subscription_clash" {
		var body string
		if err := json.Unmarshal(input.Payload, &body); err != nil || strings.TrimSpace(body) == "" {
			return errors.New("Clash template must contain text")
		}
		return nil
	}
	var object map[string]any
	if err := json.Unmarshal(input.Payload, &object); err != nil || object == nil {
		return errors.New("template payload must be an object")
	}
	switch input.Kind {
	case "outbound":
		if !templateTagPattern.MatchString(stringValue(object, "tag")) || stringValue(object, "type") == "" {
			return errors.New("outbound needs a valid tag and type")
		}
		if _, hasID := object["id"]; hasID {
			return errors.New("outbound template cannot contain a panel ID")
		}
	case "rule_set":
		if !templateTagPattern.MatchString(stringValue(object, "tag")) || stringValue(object, "type") != "remote" {
			return errors.New("rule-set template needs a valid tag and remote type")
		}
		u, err := url.Parse(stringValue(object, "url"))
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || net.ParseIP(u.Hostname()) != nil || !strings.Contains(u.Hostname(), ".") || strings.HasSuffix(strings.ToLower(u.Hostname()), ".local") {
			return errors.New("remote rule-set URL must use a public HTTPS hostname")
		}
		if f := stringValue(object, "format"); f != "binary" && f != "source" {
			return errors.New("rule-set format must be binary or source")
		}
	case "subscription_json":
		// S-UI accepts a settings object here and merges it into generated client configs.
	default:
		return errors.New("unknown template kind")
	}
	return nil
}

func stringValue(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

func (a *app) templatesHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, err := a.db.Query(`SELECT id,name,kind,created_at,updated_at FROM templates WHERE deleted_at IS NULL ORDER BY kind,name`)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		defer rows.Close()
		items := []savedTemplate{}
		for rows.Next() {
			var item savedTemplate
			if err := rows.Scan(&item.ID, &item.Name, &item.Kind, &item.CreatedAt, &item.UpdatedAt); err != nil {
				apiError(w, 500, err)
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			apiError(w, 500, err)
			return
		}
		writeJSON(w, 200, items)
	case http.MethodPost:
		var input templateInput
		if err := decode(r, &input); err != nil {
			apiError(w, 400, err)
			return
		}
		if err := validateTemplate(&input); err != nil {
			apiError(w, 400, err)
			return
		}
		ciphertext, err := a.seal(string(input.Payload))
		if err != nil {
			apiError(w, 500, err)
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		result, err := a.db.Exec(`INSERT INTO templates(name,kind,payload_cipher,created_at,updated_at) VALUES(?,?,?,?,?)`, input.Name, input.Kind, ciphertext, now, now)
		if err != nil {
			apiError(w, 409, errors.New("a template with this name already exists in this category"))
			return
		}
		id, _ := result.LastInsertId()
		writeJSON(w, 201, savedTemplate{ID: id, Name: input.Name, Kind: input.Kind, CreatedAt: now, UpdatedAt: now})
	default:
		w.Header().Set("Allow", "GET, POST")
		apiError(w, 405, errors.New("method not allowed"))
	}
}

func (a *app) templateHandler(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/templates/"), 10, 64)
	if err != nil || id < 1 {
		apiError(w, 400, errors.New("invalid template ID"))
		return
	}
	switch r.Method {
	case http.MethodGet:
		var item savedTemplate
		var ciphertext string
		err := a.db.QueryRow(`SELECT id,name,kind,payload_cipher,created_at,updated_at FROM templates WHERE id=? AND deleted_at IS NULL`, id).Scan(&item.ID, &item.Name, &item.Kind, &ciphertext, &item.CreatedAt, &item.UpdatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			apiError(w, 404, errors.New("template not found"))
			return
		}
		if err != nil {
			apiError(w, 500, err)
			return
		}
		plain, err := a.unseal(ciphertext)
		if err != nil {
			apiError(w, 500, errors.New("template cannot be decrypted with the current master key"))
			return
		}
		item.Payload = json.RawMessage(plain)
		writeJSON(w, 200, item)
	case http.MethodPut:
		var input templateInput
		if err := decode(r, &input); err != nil {
			apiError(w, 400, err)
			return
		}
		if err := validateTemplate(&input); err != nil {
			apiError(w, 400, err)
			return
		}
		ciphertext, err := a.seal(string(input.Payload))
		if err != nil {
			apiError(w, 500, err)
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		result, err := a.db.Exec(`UPDATE templates SET name=?,kind=?,payload_cipher=?,updated_at=? WHERE id=? AND deleted_at IS NULL`, input.Name, input.Kind, ciphertext, now, id)
		if err != nil {
			apiError(w, 409, fmt.Errorf("template name is already used: %w", err))
			return
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			apiError(w, 404, errors.New("template not found"))
			return
		}
		writeJSON(w, 200, savedTemplate{ID: id, Name: input.Name, Kind: input.Kind, UpdatedAt: now})
	case http.MethodDelete:
		result, err := a.db.Exec(`UPDATE templates SET deleted_at=? WHERE id=? AND deleted_at IS NULL`, time.Now().UTC().Format(time.RFC3339), id)
		if err != nil {
			apiError(w, 500, err)
			return
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			apiError(w, 404, errors.New("template not found"))
			return
		}
		writeJSON(w, 200, map[string]bool{"deleted": true})
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		apiError(w, 405, errors.New("method not allowed"))
	}
}
