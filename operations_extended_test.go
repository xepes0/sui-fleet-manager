package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateObjectsBacksUpAndVerifies(t *testing.T) {
	for _, tc := range []struct {
		action   string
		endpoint string
	}{
		{"inbound_create", "inbounds"},
		{"outbound_create", "outbounds"},
	} {
		t.Run(tc.action, func(t *testing.T) {
			a := testApp(t)
			objects := []any{}
			backups, saves := 0, 0
			panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/app/apiv2/" + tc.endpoint:
					json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{tc.endpoint: objects}})
				case "/app/apiv2/getdb":
					backups++
					w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
				case "/app/apiv2/save":
					if backups != 1 {
						t.Error("save happened before backup")
					}
					_ = r.ParseForm()
					if r.Form.Get("object") != tc.endpoint || r.Form.Get("action") != "new" {
						t.Errorf("unexpected form: %v", r.Form)
					}
					var object map[string]any
					_ = json.Unmarshal([]byte(r.Form.Get("data")), &object)
					object["id"] = float64(8)
					objects = append(objects, object)
					saves++
					json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer panel.Close()
			id := addTestServer(t, a, panel.URL)
			template := json.RawMessage(`{"type":"direct","tag":"new-tag"}`)
			w := postJSON(t, a.previewHandler, "/api/operations/preview", previewRequest{ServerIDs: []int64{id}, Action: tc.action, Object: template})
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var p preview
			_ = json.Unmarshal(w.Body.Bytes(), &p)
			if len(p.Changes) != 1 || p.Changes[0].Error != "" {
				t.Fatalf("preview: %+v", p)
			}
			w = executePreviewTest(t, a, p.ID)
			if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 1 || saves != 1 {
				t.Fatalf("execute: %s backups=%d saves=%d", w.Body.String(), backups, saves)
			}
		})
	}
}

func TestCopyInboundUsesEachPanelsOwnConfiguration(t *testing.T) {
	a := testApp(t)
	ids := []int64{}
	for _, tlsID := range []int{3, 9} {
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/app/apiv2/inbounds" {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{map[string]any{"id": 4, "type": "vless", "tag": "source", "tls_id": tlsID, "listen_port": 443, "users": []any{1}, "transport": map[string]any{"type": "ws"}}}}})
				return
			}
			http.NotFound(w, r)
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}
	req := previewRequest{ServerIDs: ids, Action: "inbound_create", SourceTag: "source", ObjectOverrides: json.RawMessage(`{"tag":"copy","listen_port":8443}`)}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatalf("preview: %s", w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	for i, c := range p.Changes {
		if c.Error != "" {
			t.Fatalf("server %d: %s", i, c.Error)
		}
		var object map[string]any
		_ = json.Unmarshal(c.After, &object)
		if object["tls_id"] != float64([]int{3, 9}[i]) || object["listen_port"] != float64(8443) || object["tag"] != "copy" || object["id"] != nil || object["users"] != nil {
			t.Fatalf("server %d clone: %v", i, object)
		}
	}
}

func TestNewInboundResolvesTLSByTagPerPanel(t *testing.T) {
	a := testApp(t)
	ids := []int64{}
	for _, tlsID := range []int{3, 9} {
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/apiv2/inbounds":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{}}})
			case "/app/apiv2/tls":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"tls": []any{map[string]any{"id": tlsID, "tag": "shared-cert"}}}})
			default:
				http.NotFound(w, r)
			}
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}
	req := previewRequest{ServerIDs: ids, Action: "inbound_create", Object: json.RawMessage(`{"type":"vless","tag":"new","listen_port":8443,"tls_id":0}`), TLSRef: "tag:shared-cert"}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatalf("preview: %s", w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	for i, c := range p.Changes {
		if c.Error != "" {
			t.Fatalf("server %d: %s", i, c.Error)
		}
		var object map[string]any
		_ = json.Unmarshal(c.After, &object)
		if object["tls_id"] != float64([]int{3, 9}[i]) {
			t.Fatalf("server %d TLS: %v", i, object["tls_id"])
		}
	}
}

func TestRouteRuleOrderingAndStaleConfig(t *testing.T) {
	a := testApp(t)
	rules := []any{map[string]any{"domain_suffix": []any{"old.example"}, "outbound": "direct"}}
	config := map[string]any{"dns": map[string]any{"strategy": "prefer_ipv4"}, "route": map[string]any{"final": "direct", "rules": rules}}
	backups, saves := 0, 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/config":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": config}})
		case "/app/apiv2/outbounds":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"outbounds": []any{map[string]any{"tag": "direct"}}}})
		case "/app/apiv2/endpoints":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"endpoints": []any{}}})
		case "/app/apiv2/getdb":
			backups++
			w.Write([]byte("SQLite format 3\x00"))
		case "/app/apiv2/save":
			_ = r.ParseForm()
			if backups != saves+1 || r.Form.Get("object") != "config" || r.Form.Get("action") != "edit" {
				t.Errorf("write without backup or wrong object: %v", r.Form)
			}
			_ = json.Unmarshal([]byte(r.Form.Get("data")), &config)
			saves++
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	rule := json.RawMessage(`{"domain_suffix":["new.example"],"outbound":"direct"}`)
	request := previewRequest{ServerIDs: []int64{id}, Action: "route_rule_add", RouteRule: rule, RoutePosition: "first"}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", request)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	var after []map[string]any
	_ = json.Unmarshal(p.Changes[0].After, &after)
	if len(after) != 2 || after[0]["outbound"] != "direct" || after[1]["domain_suffix"] == nil {
		t.Fatalf("wrong order: %s", p.Changes[0].After)
	}
	config["dns"] = map[string]any{"strategy": "ipv4_only"}
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), "changed after preview") || backups != 0 || saves != 0 {
		t.Fatalf("stale route config was written: %s", w.Body.String())
	}
	config["dns"] = map[string]any{"strategy": "prefer_ipv4"}
	w = postJSON(t, a.previewHandler, "/api/operations/preview", request)
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 1 || saves != 1 {
		t.Fatalf("route save: %s backups=%d saves=%d", w.Body.String(), backups, saves)
	}
	route := config["route"].(map[string]any)
	if route["final"] != "direct" || config["dns"].(map[string]any)["strategy"] != "prefer_ipv4" {
		t.Fatal("unrelated config was lost")
	}
	index := 1
	deleteRequest := previewRequest{ServerIDs: []int64{id}, Action: "route_rule_delete", RouteIndex: &index}
	w = postJSON(t, a.previewHandler, "/api/operations/preview", deleteRequest)
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 2 || saves != 2 {
		t.Fatalf("route delete: %s", w.Body.String())
	}
	if len(config["route"].(map[string]any)["rules"].([]any)) != 1 {
		t.Fatal("route delete kept the wrong number of rules")
	}
	index = 0
	replaceRequest := previewRequest{ServerIDs: []int64{id}, Action: "route_rule_replace", RouteIndex: &index, RouteRule: json.RawMessage(`{"domain_suffix":["replacement.example"],"outbound":"direct"}`)}
	w = postJSON(t, a.previewHandler, "/api/operations/preview", replaceRequest)
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 3 || saves != 3 {
		t.Fatalf("route replace: %s", w.Body.String())
	}
	finalRule := config["route"].(map[string]any)["rules"].([]any)[0].(map[string]any)
	if finalRule["domain_suffix"].([]any)[0] != "replacement.example" {
		t.Fatalf("route replace did not save: %v", finalRule)
	}
}

func TestInvalidExtendedInputRejected(t *testing.T) {
	a := testApp(t)
	for _, req := range []previewRequest{
		{ServerIDs: []int64{1}, Action: "inbound_create", Object: json.RawMessage(`{"type":"vless","tag":"x","id":5}`)},
		{ServerIDs: []int64{1}, Action: "outbound_patch", ObjectTag: "direct", ObjectPatch: json.RawMessage(`{"tag":"evil"}`)},
		{ServerIDs: []int64{1}, Action: "route_rule_delete"},
	} {
		w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
		if w.Code != 400 {
			t.Fatalf("invalid action accepted: %+v %s", req, w.Body.String())
		}
	}
}


func TestRouteRuleSemanticMatchWorksAcrossDifferentOrders(t *testing.T) {
	a := testApp(t)
	target := map[string]any{"domain_suffix": []any{"shared.example"}, "outbound": "direct"}
	ids := []int64{}
	orders := [][]any{
		{map[string]any{"protocol": "dns", "action": "hijack-dns"}, target},
		{target, map[string]any{"ip_cidr": []any{"10.0.0.0/8"}, "outbound": "direct"}},
	}
	for _, initial := range orders {
		rules := append([]any{}, initial...)
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/apiv2/config":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": map[string]any{"route": map[string]any{"rules": rules}}}})
			case "/app/apiv2/outbounds":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"outbounds": []any{map[string]any{"tag": "direct"}}}})
			case "/app/apiv2/endpoints":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"endpoints": []any{}}})
			default:
				http.NotFound(w, r)
			}
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}

	match, _ := json.Marshal(target)
	replacement := json.RawMessage(`{"domain_suffix":["replacement.example"],"outbound":"direct"}`)
	req := previewRequest{
		ServerIDs: ids,
		Action: "route_rule_replace",
		RouteRule: replacement,
		RouteMatch: match,
	}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
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
	for i, change := range p.Changes {
		if change.Error != "" {
			t.Fatalf("server %d preview failed: %s", i, change.Error)
		}
		var after []map[string]any
		if err := json.Unmarshal(change.After, &after); err != nil {
			t.Fatal(err)
		}
		expectedIndex := []int{1, 0}[i]
		if after[expectedIndex]["domain_suffix"].([]any)[0] != "replacement.example" {
			t.Fatalf("server %d replaced wrong route: %s", i, change.After)
		}
	}
}

func TestRouteRuleSemanticMatchRejectsMissingOrDuplicateRule(t *testing.T) {
	target := json.RawMessage(`{"domain_suffix":["shared.example"],"outbound":"direct"}`)
	if _, err := matchedRouteIndex([]any{map[string]any{"outbound": "direct"}}, target); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not found error, got %v", err)
	}
	var object map[string]any
	if err := json.Unmarshal(target, &object); err != nil {
		t.Fatal(err)
	}
	if _, err := matchedRouteIndex([]any{object, cloneMap(object)}, target); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("expected duplicate error, got %v", err)
	}
}
