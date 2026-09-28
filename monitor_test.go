package main

import "testing"

func TestProjectMonitorNodesFiltersHiddenAndSensitiveFields(t *testing.T) {
	nodes := map[string]any{
		"visible": map[string]any{"name": "HK", "region": "HK", "price": 10, "token": "secret", "ipv4": "192.0.2.1"},
		"hidden":  map[string]any{"name": "Private", "hidden": true},
	}
	status := map[string]any{"visible": map[string]any{"online": true, "cpu": 3, "client": "secret"}}
	got := projectMonitorNodes(nodes, status)
	if len(got) != 1 || got[0]["uuid"] != "visible" || got[0]["name"] != "HK" {
		t.Fatalf("unexpected monitor nodes: %#v", got)
	}
	if _, ok := got[0]["token"]; ok {
		t.Fatal("token leaked into monitor projection")
	}
	if _, ok := got[0]["ipv4"]; ok {
		t.Fatal("IP leaked into monitor projection")
	}
	if live, ok := got[0]["status"].(map[string]any); !ok || live["online"] != true || live["client"] != nil {
		t.Fatalf("unexpected status projection: %#v", got[0]["status"])
	}
}
