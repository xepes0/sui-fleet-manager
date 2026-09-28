package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRuleSetTemplatePreviewPreservesRulesAndBacksUp(t *testing.T) {
	a := testApp(t)
	config := map[string]any{"route": map[string]any{"rules": []any{map[string]any{"action": "sniff"}}, "rule_set": []any{map[string]any{"tag": "existing", "type": "remote", "format": "binary", "url": "https://example.com/old.srs"}}}}
	backedUp := false
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "test-token" {
			http.Error(w, "missing token", 401)
			return
		}
		switch r.URL.Path {
		case "/app/apiv2/config":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": config}})
		case "/app/apiv2/getdb":
			backedUp = true
			w.Write(append([]byte("SQLite format 3\x00"), make([]byte, 100)...))
		case "/app/apiv2/save":
			if !backedUp {
				t.Error("configuration saved before backup")
			}
			if err := r.ParseForm(); err != nil {
				t.Error(err)
			}
			if r.Form.Get("object") != "config" || r.Form.Get("action") != "edit" {
				t.Errorf("unexpected save form: %v", r.Form)
			}
			if err := json.Unmarshal([]byte(r.Form.Get("data")), &config); err != nil {
				t.Error(err)
			}
			json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	req := previewRequest{ServerIDs: []int64{id}, Action: "rule_set_apply", Object: json.RawMessage(`{"type":"remote","tag":"new","format":"binary","url":"https://example.com/new.srs"}`)}
	if err := validateRuleSetApplication(req); err != nil {
		t.Fatal(err)
	}
	s, _ := a.getServer(id)
	c := change{ServerID: id, ServerName: s.Name, Action: req.Action, ServerFingerprint: serverFingerprint(s)}
	previewRuleSetApplication(context.Background(), a, s, req, &c)
	if c.Error != "" {
		t.Fatal(c.Error)
	}
	var after map[string]any
	if err := json.Unmarshal(c.After, &after); err != nil {
		t.Fatal(err)
	}
	route := after["route"].(map[string]any)
	if len(route["rules"].([]any)) != 1 || len(route["rule_set"].([]any)) != 2 {
		t.Fatalf("existing config changed: %v", route)
	}
	if _, err := executeRuleSetApplication(context.Background(), a, s, c); err != nil {
		t.Fatal(err)
	}
	if !backedUp {
		t.Fatal("missing backup")
	}
}
