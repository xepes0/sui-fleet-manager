package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVerificationReconnectsAfterSaveWithoutRepeatingWrite(t *testing.T) {
	a := testApp(t)
	a.client.Transport = &http.Transport{DisableKeepAlives: true}
	defer a.client.CloseIdleConnections()
	saved, backups, verificationReads := 0, 0, 0
	config := map[string]any{"route": map[string]any{"rules": []any{map[string]any{"action": "sniff"}, map[string]any{"action": "hijack-dns"}}}}
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/config":
			if saved > 0 {
				verificationReads++
				if verificationReads <= 2 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
					return
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": config}})
		case "/app/apiv2/getdb":
			backups++
			w.Write([]byte("SQLite format 3\x00"))
		case "/app/apiv2/save":
			if backups != 1 {
				t.Error("save without backup")
			}
			saved++
			r.ParseForm()
			json.Unmarshal([]byte(r.Form.Get("data")), &config)
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	req := previewRequest{ServerIDs: []int64{id}, Action: "route_rule_reorder", RouteMoves: []routeMove{{Rule: json.RawMessage(`{"action":"hijack-dns"}`), Kind: "first"}}}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	var p preview
	json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Changes) != 1 || p.Changes[0].Error != "" {
		t.Fatal(w.Body.String())
	}
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || saved != 1 || backups != 1 || verificationReads != 3 {
		t.Fatalf("verification did not reconnect safely: %s saves=%d backups=%d reads=%d", w.Body.String(), saved, backups, verificationReads)
	}
}

func TestVerificationDoesNotRetryAuthorizationOrInvalidJSON(t *testing.T) {
	for _, invalidJSON := range []bool{false, true} {
		a := testApp(t)
		reads := 0
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reads++
			if invalidJSON {
				w.Write([]byte("not JSON"))
			} else {
				http.Error(w, "denied", http.StatusForbidden)
			}
		}))
		id := addTestServer(t, a, panel.URL)
		s, _ := a.getServer(id)
		_, err := a.suiGetAfterSave(context.Background(), s, "config")
		panel.Close()
		if err == nil || reads != 1 {
			t.Fatalf("permanent error retried: %v reads=%d", err, reads)
		}
	}
}

func TestVerificationRespectsCancellationAndRejectsPermanentErrors(t *testing.T) {
	a := testApp(t)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { conn, _, _ := w.(http.Hijacker).Hijack(); conn.Close() }))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	s, _ := a.getServer(id)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	_, err := a.suiGetAfterSave(ctx, s, "config")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if !transientVerificationRead(io.ErrUnexpectedEOF) || transientVerificationRead(errors.New("S-UI HTTP 403")) {
		t.Fatal("incorrect transient classification")
	}
}
