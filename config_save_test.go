package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBatchConfigResolvesClientInboundTagsPerServer(t *testing.T) {
	a := testApp(t)
	clientExists := false
	makePanel := func(id int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/apiv2/clients":
				clients := []any{}
				if clientExists {
					clients = append(clients, map[string]any{"id": 3, "name": "alice", "enable": true, "inbounds": []any{id}, "config": map[string]any{"vless": map[string]any{"uuid": "6fc83876-447e-4629-9998-2bda873bb70e"}}})
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": clients}})
			case "/app/apiv2/inbounds":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{map[string]any{"id": id, "tag": "shared", "type": "vless"}}}})
			default:
				http.NotFound(w, r)
			}
		}))
	}
	first, second := makePanel(4), makePanel(27)
	defer first.Close()
	defer second.Close()
	id1, id2 := addTestServer(t, a, first.URL), addTestServer(t, a, second.URL)
	req := previewRequest{Action: "config_save", ConfigTarget: "clients", ConfigMode: "new", ConfigInboundTags: []string{"shared"}, Object: json.RawMessage(`{"name":"alice","enable":true,"config":{"vless":{"name":"alice","uuid":"6fc83876-447e-4629-9998-2bda873bb70e"}},"inbounds":[]}`)}
	for _, tc := range []struct {
		serverID  int64
		inboundID float64
	}{{id1, 4}, {id2, 27}} {
		s, err := a.getServer(tc.serverID)
		if err != nil {
			t.Fatal(err)
		}
		var c change
		previewConfigSave(context.Background(), a, s, req, &c)
		if c.Error != "" {
			t.Fatal(c.Error)
		}
		var got map[string]any
		if err := json.Unmarshal(c.After, &got); err != nil {
			t.Fatal(err)
		}
		ids := got["inbounds"].([]any)
		if len(ids) != 1 || ids[0] != tc.inboundID {
			t.Fatalf("server %d got IDs %v", tc.serverID, ids)
		}
	}
	req.ConfigInboundTags = []string{"missing"}
	s, _ := a.getServer(id1)
	var c change
	previewConfigSave(context.Background(), a, s, req, &c)
	if !strings.Contains(c.Error, "missing") {
		t.Fatalf("missing Tag not reported: %q", c.Error)
	}
	clientExists = true
	req.ConfigMode = "patch"
	req.ConfigIdentity = "name:alice"
	req.ConfigInboundTags = []string{"shared"}
	req.ConfigPatch = []configPatchOp{{Op: "set", Path: []any{"remark"}, Value: json.RawMessage(`"updated"`)}}
	for _, tc := range []struct {
		serverID  int64
		inboundID float64
	}{{id1, 4}, {id2, 27}} {
		s, _ := a.getServer(tc.serverID)
		var patched change
		previewConfigSave(context.Background(), a, s, req, &patched)
		if patched.Error != "" {
			t.Fatal(patched.Error)
		}
		var got map[string]any
		if err := json.Unmarshal(patched.After, &got); err != nil {
			t.Fatal(err)
		}
		if got["inbounds"].([]any)[0] != tc.inboundID || got["remark"] != "updated" {
			t.Fatalf("server %d patch: %v", tc.serverID, got)
		}
	}
}

func TestBatchInboundCopyPreservesPerServerOptionsAndPublicAddress(t *testing.T) {
	a := testApp(t)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/inbounds":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{map[string]any{"id": 8, "tag": "source", "type": "vless", "listen": "::", "listen_port": 443, "tls_id": 6, "transport": map[string]any{"type": "ws", "path": "/keep"}}}}})
		case "/app/apiv2/tls":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"tls": []any{map[string]any{"id": 6, "name": "shared-cert"}}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	s, _ := a.getServer(id)
	req := previewRequest{Action: "config_save", ConfigTarget: "inbounds", ConfigMode: "new", ConfigSourceTag: "source", ConfigPublicAddrs: map[string]configPublicAddr{fmt.Sprint(id): {Server: "new.example.com", Port: 8443}}, Object: json.RawMessage(`{"tag":"new","type":"vless","listen":"::","listen_port":8443,"tls_id":0,"addrs":[],"out_json":{}}`)}
	var c change
	previewConfigSave(context.Background(), a, s, req, &c)
	if c.Error != "" {
		t.Fatal(c.Error)
	}
	var got map[string]any
	if err := json.Unmarshal(c.After, &got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["id"]; ok {
		t.Fatal("copied database ID")
	}
	if got["tls_id"] != float64(6) || got["transport"].(map[string]any)["path"] != "/keep" {
		t.Fatalf("lost source options: %v", got)
	}
	if got["out_json"].(map[string]any)["server"] != "new.example.com" {
		t.Fatalf("public address missing: %v", got)
	}
	req.ConfigPatch = []configPatchOp{{Op: "set", Path: []any{"transport", "path"}, Value: json.RawMessage(`"/edited"`)}}
	previewConfigSave(context.Background(), a, s, req, &c)
	if c.Error != "" {
		t.Fatal(c.Error)
	}
	if err := json.Unmarshal(c.After, &got); err != nil {
		t.Fatal(err)
	}
	if got["transport"].(map[string]any)["path"] != "/edited" {
		t.Fatalf("copy field change missing: %v", got)
	}
	req.ConfigPatch = []configPatchOp{{Op: "set", Path: []any{"tls_id"}, Value: json.RawMessage(`0`)}}
	if err := validateConfigRequest(req); err == nil {
		t.Fatal("copy allowed a managed TLS ID override")
	}
	req.ConfigPatch = nil
	req.ConfigSourceTag = ""
	req.ConfigTLSName = "shared-cert"
	previewConfigSave(context.Background(), a, s, req, &c)
	if c.Error != "" {
		t.Fatal(c.Error)
	}
	if err := json.Unmarshal(c.After, &got); err != nil {
		t.Fatal(err)
	}
	if got["tls_id"] != float64(6) {
		t.Fatalf("TLS name not mapped: %v", got)
	}
}

func TestFullConfigEditPreservesNestedFieldsAndRejectsStalePreview(t *testing.T) {
	a := testApp(t)
	inbound := map[string]any{"id": float64(4), "type": "vless", "tag": "vless", "listen_port": float64(443), "tls_id": float64(2), "transport": map[string]any{"type": "ws", "path": "/old"}, "out_json": map[string]any{"server": "example.com"}}
	backups, saves := 0, 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/inbounds":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{inbound}}})
		case "/app/apiv2/getdb":
			backups++
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
		case "/app/apiv2/save":
			if backups != 1 {
				t.Fatal("configuration saved before backup")
			}
			_ = r.ParseForm()
			if r.Form.Get("object") != "inbounds" || r.Form.Get("action") != "edit" {
				t.Errorf("wrong S-UI operation: %v", r.Form)
			}
			_ = json.Unmarshal([]byte(r.Form.Get("data")), &inbound)
			saves++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	req := previewRequest{ServerIDs: []int64{id}, Action: "config_save", ConfigTarget: "inbounds", ConfigMode: "edit", ConfigIdentity: "4", Object: json.RawMessage(`{"id":4,"type":"vless","tag":"vless","listen_port":8443,"tls_id":2,"transport":{"type":"ws","path":"/new"},"out_json":{"server":"example.com"}}`)}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	inbound["listen_port"] = float64(9443)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), "changed after preview") || backups != 0 || saves != 0 {
		t.Fatalf("stale edit was not stopped: %s", w.Body.String())
	}
	inbound["listen_port"] = float64(443)
	w = postJSON(t, a.previewHandler, "/api/operations/preview", req)
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 1 || saves != 1 {
		t.Fatalf("full edit failed: %s", w.Body.String())
	}
	if inbound["tls_id"] != float64(2) || inbound["transport"].(map[string]any)["path"] != "/new" || inbound["out_json"].(map[string]any)["server"] != "example.com" {
		t.Fatalf("nested fields were lost: %v", inbound)
	}
}

func TestPanelSettingsPatchAndEightCategoryRead(t *testing.T) {
	a := testApp(t)
	settings := map[string]any{"webPort": "2095", "subUpdates": "12", "subEncode": "true"}
	backup, save := 0, 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/app/apiv2/"
		if !strings.HasPrefix(r.URL.Path, base) {
			http.NotFound(w, r)
			return
		}
		target := strings.TrimPrefix(r.URL.Path, base)
		switch target {
		case "getdb":
			backup++
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
		case "save":
			_ = r.ParseForm()
			if backup != 1 || r.Form.Get("object") != "settings" || r.Form.Get("action") != "set" || r.Form.Get("data") != `{"subUpdates":"6"}` {
				t.Errorf("settings write not minimal or not backed up: %v", r.Form)
			}
			settings["subUpdates"] = "6"
			save++
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			found := false
			for _, key := range configTargets {
				if target == key {
					found = true
				}
			}
			if !found {
				http.NotFound(w, r)
				return
			}
			if target == "settings" {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": settings})
				return
			}
			value := any([]any{})
			if target == "config" {
				value = map[string]any{"route": map[string]any{"rules": []any{}}}
			} else if target == "services" || target == "endpoints" {
				value = nil
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{target: value}})
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	r := httptest.NewRequest("GET", "/api/servers/1/configuration", nil)
	w := httptest.NewRecorder()
	registered, err := a.getServer(id)
	if err != nil {
		t.Fatal(err)
	}
	a.configurationHandler(w, r, registered)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"services":[]`) || !strings.Contains(w.Body.String(), `"settings"`) {
		t.Fatalf("eight-category read: %s", w.Body.String())
	}
	req := previewRequest{ServerIDs: []int64{id}, Action: "config_save", ConfigTarget: "settings", ConfigMode: "set", Object: json.RawMessage(`{"subUpdates":"6"}`)}
	w = postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backup != 1 || save != 1 || settings["webPort"] != "2095" {
		t.Fatalf("settings patch failed: %s", w.Body.String())
	}
}

func TestBatchPatchUsesEachServersOwnObjectAndBacksUp(t *testing.T) {
	a := testApp(t)
	type panelState struct {
		inbound        map[string]any
		backups, saves int
	}
	states := []*panelState{
		{inbound: map[string]any{"id": float64(2), "tag": "shared", "type": "vless", "listen_port": float64(443), "transport": map[string]any{"type": "ws", "path": "/first"}, "tls_id": float64(5)}},
		{inbound: map[string]any{"id": float64(9), "tag": "shared", "type": "vless", "listen_port": float64(444), "transport": map[string]any{"type": "ws", "path": "/second"}, "tls_id": float64(8)}},
	}
	ids := make([]int64, 0, 2)
	for _, state := range states {
		state := state
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/apiv2/inbounds":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{state.inbound}}})
			case "/app/apiv2/getdb":
				state.backups++
				w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
			case "/app/apiv2/save":
				_ = r.ParseForm()
				if state.backups != 1 || r.Form.Get("action") != "edit" {
					t.Errorf("write before backup or wrong action: %v", r.Form)
				}
				_ = json.Unmarshal([]byte(r.Form.Get("data")), &state.inbound)
				state.saves++
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
			default:
				http.NotFound(w, r)
			}
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}
	req := previewRequest{ServerIDs: ids, Action: "config_save", ConfigTarget: "inbounds", ConfigMode: "patch", ConfigIdentity: "tag:shared", ConfigPatch: []configPatchOp{{Op: "set", Path: []any{"transport", "path"}, Value: json.RawMessage(`"/new"`)}}}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Changes) != 2 || p.Changes[0].Error != "" || p.Changes[1].Error != "" {
		t.Fatalf("preview failed: %s", w.Body.String())
	}
	var first, second map[string]any
	_ = json.Unmarshal(p.Changes[0].After, &first)
	_ = json.Unmarshal(p.Changes[1].After, &second)
	if first["tls_id"] != float64(5) || second["tls_id"] != float64(8) || first["id"] != float64(2) || second["id"] != float64(9) {
		t.Fatalf("server specific config was overwritten: %v %v", first, second)
	}
	w = executePreviewTest(t, a, p.ID)
	if strings.Count(w.Body.String(), `"ok":true`) != 2 {
		t.Fatalf("batch execute: %s", w.Body.String())
	}
	for _, state := range states {
		if state.backups != 1 || state.saves != 1 || state.inbound["transport"].(map[string]any)["path"] != "/new" {
			t.Fatalf("panel was not patched independently: %+v", state)
		}
	}
}

func TestBatchInboundPublicAddressPatchIsPerServer(t *testing.T) {
	a := testApp(t)
	ids := make([]int64, 0, 2)
	for _, existing := range []string{"first.example.com", "second.example.com"} {
		inbound := map[string]any{"id": 4, "tag": "shared", "type": "vless", "listen": "::", "listen_port": 443, "addrs": []any{map[string]any{"server": existing, "server_port": 443}, map[string]any{"server": "fallback.example.com", "server_port": 443}}, "out_json": map[string]any{"type": "vless", "server": existing, "server_port": 443, "transport": map[string]any{"type": "ws"}}}
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/app/apiv2/inbounds" {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{inbound}}})
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}
	req := previewRequest{ServerIDs: ids, Action: "config_save", ConfigTarget: "inbounds", ConfigMode: "patch", ConfigIdentity: "tag:shared", ConfigPublicAddrs: map[string]configPublicAddr{fmt.Sprint(ids[0]): {Server: "new.example.com", Port: 8443}}}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Changes) != 2 || p.Changes[0].Error != "" || p.Changes[1].Error != "no configuration fields changed" {
		t.Fatalf("per-server preview: %s", w.Body.String())
	}
	var first map[string]any
	_ = json.Unmarshal(p.Changes[0].After, &first)
	if first["out_json"].(map[string]any)["server"] != "new.example.com" || first["out_json"].(map[string]any)["transport"].(map[string]any)["type"] != "ws" {
		t.Fatalf("public address patch lost existing options: %v", first)
	}
	if first["addrs"].([]any)[1].(map[string]any)["server"] != "fallback.example.com" {
		t.Fatalf("secondary public address was removed: %v", first)
	}
}

func TestBatchNewClientUsesEachServersInboundTags(t *testing.T) {
	a := testApp(t)
	type panelState struct {
		tag           string
		inboundID     int
		client        map[string]any
		backups, save int
	}
	states := []*panelState{{tag: "us-vless", inboundID: 4}, {tag: "hk-vless", inboundID: 27}}
	ids := make([]int64, 0, len(states))
	for _, state := range states {
		state := state
		panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/apiv2/inbounds":
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{map[string]any{"id": state.inboundID, "tag": state.tag, "type": "vless"}}}})
			case "/app/apiv2/clients":
				clients := []any{}
				if state.client != nil {
					clients = append(clients, state.client)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": clients}})
			case "/app/apiv2/getdb":
				state.backups++
				w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
			case "/app/apiv2/save":
				_ = r.ParseForm()
				if state.backups != 1 || r.Form.Get("object") != "clients" || r.Form.Get("action") != "new" {
					t.Errorf("client write without backup: %v", r.Form)
				}
				_ = json.Unmarshal([]byte(r.Form.Get("data")), &state.client)
				state.client["id"] = float64(3)
				state.save++
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
			default:
				http.NotFound(w, r)
			}
		}))
		defer panel.Close()
		ids = append(ids, addTestServer(t, a, panel.URL))
	}
	selected := map[string][]string{fmt.Sprint(ids[0]): {"us-vless"}, fmt.Sprint(ids[1]): {"hk-vless"}}
	req := previewRequest{ServerIDs: ids, Action: "config_save", ConfigTarget: "clients", ConfigMode: "new", ConfigInboundsByServer: selected, Object: json.RawMessage(`{"name":"batch-user","remark":"Batch User","enable":true,"inbounds":[],"config":{"vless":{"name":"batch-user","uuid":"6fc83876-447e-4629-9998-2bda873bb70e"}}}`)}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	for index, c := range p.Changes {
		if c.Error != "" {
			t.Fatalf("server %d preview failed: %s", index, c.Error)
		}
		var after map[string]any
		_ = json.Unmarshal(c.After, &after)
		if after["inbounds"].([]any)[0] != float64(states[index].inboundID) {
			t.Fatalf("wrong inbound mapping: %v", after)
		}
	}
	w = executePreviewTest(t, a, p.ID)
	if strings.Count(w.Body.String(), `"ok":true`) != 2 {
		t.Fatalf("batch creation failed: %s", w.Body.String())
	}
	for _, state := range states {
		if state.backups != 1 || state.save != 1 || state.client["inbounds"].([]any)[0] != float64(state.inboundID) {
			t.Fatalf("client was not written to its own inbound: %+v", state)
		}
	}
}

func TestBatchTagRenameChecksReferencesAndConflicts(t *testing.T) {
	a := testApp(t)
	oldTag, newTag := "socks-old", "socks-new"
	outbounds := []any{map[string]any{"id": 8, "tag": oldTag, "type": "socks", "server": "example.com", "server_port": 1080}}
	referenced := false
	backups := 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := strings.TrimPrefix(r.URL.Path, "/app/apiv2/")
		switch target {
		case "outbounds":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"outbounds": outbounds}})
		case "config":
			final := "direct"
			if referenced {
				final = oldTag
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"config": map[string]any{"route": map[string]any{"final": final}}}})
		case "inbounds", "endpoints", "services":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{target: []any{}}})
		case "getdb":
			backups++
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 20)...))
		case "save":
			_ = r.ParseForm()
			var item map[string]any
			_ = json.Unmarshal([]byte(r.Form.Get("data")), &item)
			outbounds[0] = item
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	req := previewRequest{ServerIDs: []int64{id}, Action: "config_save", ConfigTarget: "outbounds", ConfigMode: "patch", ConfigIdentity: "tag:" + oldTag, ConfigPatch: []configPatchOp{{Op: "set", Path: []any{"tag"}, Value: mustJSON(newTag)}}}
	referenced = true
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	var p preview
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Changes) != 1 || !strings.Contains(p.Changes[0].Error, "config.route.final") {
		t.Fatalf("reference was not detected: %s", w.Body.String())
	}
	referenced = false
	outbounds = append(outbounds, map[string]any{"id": 9, "tag": newTag, "type": "direct"})
	w = postJSON(t, a.previewHandler, "/api/operations/preview", req)
	p = preview{}
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if !strings.Contains(p.Changes[0].Error, "already exists") {
		t.Fatalf("duplicate Tag was not detected: %s", w.Body.String())
	}
	outbounds = outbounds[:1]
	w = postJSON(t, a.previewHandler, "/api/operations/preview", req)
	p = preview{}
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if p.Changes[0].Error != "" {
		t.Fatalf("safe rename rejected: %s", w.Body.String())
	}
	w = executePreviewTest(t, a, p.ID)
	if !strings.Contains(w.Body.String(), `"ok":true`) || backups != 1 || outbounds[0].(map[string]any)["tag"] != newTag {
		t.Fatalf("safe rename failed: %s", w.Body.String())
	}
}


func TestNewClientAddsLinksAndIgnoresTrafficOnlyListChanges(t *testing.T) {
	a := testApp(t)
	traffic := float64(1)
	var saved map[string]any
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/apiv2/clients":
			if r.URL.Query().Get("id") == "2" && saved != nil {
				detail := cloneMap(saved)
				// Older S-UI builds do not return every client field even on
				// an ID-scoped lookup. Missing optional fields must not turn a
				// successful create into a false failure.
				delete(detail, "remark")
				delete(detail, "config")
				detail["links"] = []any{map[string]any{"remark": "vless-main", "type": "local", "uri": "vless://generated"}}
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": []any{detail}}})
				return
			}
			clients := []any{
				map[string]any{
					"id": 1, "name": "existing", "enable": true, "up": traffic, "down": float64(0),
					"inbounds": []any{float64(4)},
				},
			}
			if saved != nil {
				clients = append(clients, map[string]any{
					"id": saved["id"], "name": saved["name"], "enable": saved["enable"],
					"remark": saved["remark"], "inbounds": saved["inbounds"],
					"volume": saved["volume"], "expiry": saved["expiry"],
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": clients}})
		case "/app/apiv2/inbounds":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"inbounds": []any{map[string]any{"id": 4, "tag": "vless-main", "type": "vless"}}}})
		case "/app/apiv2/getdb":
			w.Write(append([]byte("SQLite format 3\x00"), bytes.Repeat([]byte{0}, 32)...))
		case "/app/apiv2/save":
			if err := r.ParseForm(); err != nil {
				t.Error(err)
				return
			}
			if r.Form.Get("object") != "clients" || r.Form.Get("action") != "new" {
				t.Errorf("unexpected save form: %v", r.Form)
				return
			}
			if err := json.Unmarshal([]byte(r.Form.Get("data")), &saved); err != nil {
				t.Errorf("invalid client JSON: %v", err)
				return
			}
			links, ok := saved["links"].([]any)
			if !ok || len(links) != 0 {
				t.Errorf("new client links must be an empty JSON array: %#v", saved["links"])
			}
			saved["id"] = float64(2)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "msg": "save", "obj": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()

	id := addTestServer(t, a, panel.URL)
	req := previewRequest{
		ServerIDs:              []int64{id},
		Action:                 "config_save",
		ConfigTarget:           "clients",
		ConfigMode:             "new",
		ConfigInboundsByServer: map[string][]string{fmt.Sprint(id): {"vless-main"}},
		Object: json.RawMessage(`{"name":"new-user","remark":"New User","enable":true,"volume":0,"expiry":0,"config":{"vless":{"name":"new-user","uuid":"25e7c194-e95d-487a-a633-05f7e1a5d13c"}},"inbounds":[]}`),
	}
	w := postJSON(t, a.previewHandler, "/api/operations/preview", req)
	if w.Code != http.StatusOK {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	}
	var p preview
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Changes) != 1 || p.Changes[0].Error != "" {
		t.Fatalf("unexpected preview: %s", w.Body.String())
	}
	var after map[string]any
	if err := json.Unmarshal(p.Changes[0].After, &after); err != nil {
		t.Fatal(err)
	}
	if links, ok := after["links"].([]any); !ok || len(links) != 0 {
		t.Fatalf("preview did not normalize links: %#v", after["links"])
	}

	traffic = 2
	w = executePreviewTest(t, a, p.ID)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("execute after traffic change: %d %s", w.Code, w.Body.String())
	}
	if saved == nil || saved["name"] != "new-user" {
		t.Fatalf("client was not saved: %#v", saved)
	}
}


func TestVerifyNewClientSavedRejectsReturnedMismatch(t *testing.T) {
	expected := map[string]any{
		"name": "alice",
		"enable": true,
		"config": map[string]any{"vless": map[string]any{"name": "alice", "uuid": "expected"}},
	}
	actual := map[string]any{
		"name": "alice",
		"enable": false,
	}
	if err := verifyNewClientSaved(expected, actual); err == nil || !strings.Contains(err.Error(), "field enable did not match") {
		t.Fatalf("expected returned mismatch to fail verification, got %v", err)
	}
}
