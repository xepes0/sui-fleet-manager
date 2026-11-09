package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRouteReorderPreservesPanelOnlySlots(t *testing.T) {
	a := map[string]any{"action": "sniff"}
	b := map[string]any{"action": "hijack-dns", "protocol": []any{"dns"}}
	extra := map[string]any{"action": "reject", "domain": []any{"local.example"}}
	after, err := reorderRouteRules([]any{a, extra, b}, []json.RawMessage{mustJSON(b), mustJSON(a)})
	if err != nil || !reflect.DeepEqual(after, []any{b, extra, a}) {
		t.Fatalf("reorder: %v %v", after, err)
	}
	if _, err := reorderRouteRules([]any{a, a, b}, []json.RawMessage{mustJSON(b), mustJSON(a)}); err == nil {
		t.Fatal("duplicate match accepted")
	}
	if _, err := reorderRouteRules([]any{a}, []json.RawMessage{mustJSON(b), mustJSON(a)}); err == nil {
		t.Fatal("missing match accepted")
	}
	req := previewRequest{Action: "route_rule_reorder", RouteOrder: []json.RawMessage{mustJSON(a), mustJSON(a)}}
	if validateExtendedRequest(req) == nil {
		t.Fatal("duplicate request accepted")
	}
}

func TestRouteReorderPreviewBackupStaleAndSave(t *testing.T) {
	app := testApp(t)
	first := map[string]any{"action": "sniff"}
	last := map[string]any{"action": "hijack-dns"}
	config := map[string]any{"dns": map[string]any{"strategy": "prefer_ipv4"}, "route": map[string]any{"rules": []any{first, last}, "final": "direct"}}
	backups, saves := 0, 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/config":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": config}})
		case "/app/apiv2/getdb":
			backups++
			w.Write([]byte("SQLite format 3\x00"))
		case "/app/apiv2/save":
			r.ParseForm()
			if backups != saves+1 || r.Form.Get("object") != "config" {
				t.Error("missing pre-write backup")
			}
			json.Unmarshal([]byte(r.Form.Get("data")), &config)
			saves++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, app, panel.URL)
	req := previewRequest{ServerIDs: []int64{id}, Action: "route_rule_reorder", RouteOrder: []json.RawMessage{mustJSON(last), mustJSON(first)}}
	getPreview := func() preview {
		w := postJSON(t, app.previewHandler, "/api/operations/preview", req)
		var p preview
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		json.Unmarshal(w.Body.Bytes(), &p)
		if len(p.Changes) != 1 || p.Changes[0].Error != "" {
			t.Fatal(w.Body.String())
		}
		return p
	}
	p := getPreview()
	config["dns"] = map[string]any{"strategy": "ipv4_only"}
	w := executePreviewTest(t, app, p.ID)
	if !strings.Contains(w.Body.String(), "changed after preview") || backups != 0 || saves != 0 {
		t.Fatal(w.Body.String())
	}
	p = getPreview()
	w = executePreviewTest(t, app, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 1 || saves != 1 {
		t.Fatal(w.Body.String())
	}
	if config["route"].(map[string]any)["rules"].([]any)[0].(map[string]any)["action"] != "hijack-dns" || config["dns"].(map[string]any)["strategy"] != "ipv4_only" {
		t.Fatal("order or unrelated config lost")
	}
}
