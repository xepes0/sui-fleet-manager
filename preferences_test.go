package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMonitorOrderPreferencePersistsAndDeduplicates(t *testing.T) {
	a := testApp(t)

	body := []byte(`{"order":["node-b","node-a","node-b"]}`)
	req := httptest.NewRequest(http.MethodPut, "/api/preferences/monitor-order", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.monitorOrderHandler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", w.Code, w.Body.String())
	}

	var saved monitorOrderPreference
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Order) != 2 || saved.Order[0] != "node-b" || saved.Order[1] != "node-a" {
		t.Fatalf("unexpected saved order: %#v", saved.Order)
	}

	w = httptest.NewRecorder()
	a.monitorOrderHandler(w, httptest.NewRequest(http.MethodGet, "/api/preferences/monitor-order", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET status=%d body=%s", w.Code, w.Body.String())
	}
	var got monitorOrderPreference
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Order) != 2 || got.Order[0] != "node-b" || got.Order[1] != "node-a" {
		t.Fatalf("unexpected persisted order: %#v", got.Order)
	}
}

func TestMonitorOrderPreferenceRejectsInvalidIDs(t *testing.T) {
	a := testApp(t)
	req := httptest.NewRequest(http.MethodPut, "/api/preferences/monitor-order", bytes.NewReader([]byte(`{"order":[""]}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.monitorOrderHandler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
