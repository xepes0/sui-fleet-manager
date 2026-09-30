package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const monitorOrderKey = "monitor_order"

type monitorOrderPreference struct {
	Order []string `json:"order"`
}

func initializePreferenceStore(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS preferences (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`)
	return err
}

func (a *app) monitorOrderHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		var raw string
		err := a.db.QueryRow(`SELECT value FROM preferences WHERE key=?`, monitorOrderKey).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusOK, monitorOrderPreference{Order: []string{}})
			return
		}
		if err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		var pref monitorOrderPreference
		if err := json.Unmarshal([]byte(raw), &pref); err != nil {
			apiError(w, http.StatusInternalServerError, errors.New("invalid stored monitor order"))
			return
		}
		if pref.Order == nil {
			pref.Order = []string{}
		}
		writeJSON(w, http.StatusOK, pref)

	case http.MethodPut:
		var body monitorOrderPreference
		if err := decode(r, &body); err != nil {
			apiError(w, http.StatusBadRequest, err)
			return
		}
		if len(body.Order) > 500 {
			apiError(w, http.StatusBadRequest, errors.New("too many monitor nodes"))
			return
		}
		clean := make([]string, 0, len(body.Order))
		seen := make(map[string]struct{}, len(body.Order))
		for _, id := range body.Order {
			id = strings.TrimSpace(id)
			if id == "" || len(id) > 200 {
				apiError(w, http.StatusBadRequest, errors.New("invalid monitor node ID"))
				return
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			clean = append(clean, id)
		}
		body.Order = clean
		raw, err := json.Marshal(body)
		if err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		if _, err := a.db.Exec(`INSERT INTO preferences(key,value) VALUES(?,?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value`, monitorOrderKey, string(raw)); err != nil {
			apiError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, body)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
