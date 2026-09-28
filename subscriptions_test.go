package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSubscriptionProjectionOmitsClientCredentials(t *testing.T) {
	a := testApp(t)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "test-token" {
			http.Error(w, "unauthorized", 401)
			return
		}
		switch r.URL.Path {
		case "/app/apiv2/clients":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"clients": []any{map[string]any{"name": "alice", "remark": "Alice", "enable": true, "volume": 1000, "up": 100, "down": 200, "config": map[string]any{"trojan": map[string]any{"password": "sensitive-marker"}}}}}})
		case "/app/apiv2/settings":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "obj": map[string]any{"settings": map[string]any{"subURI": "https://subs.example.com/sub/"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	id := addTestServer(t, a, panel.URL)
	w := httptest.NewRecorder()
	a.subscriptionsHandler(w, httptest.NewRequest(http.MethodGet, "/api/subscriptions?server_id=1", nil))
	if id != 1 || w.Code != 200 {
		t.Fatalf("subscriptions: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "sensitive-marker") {
		t.Fatal("client credentials leaked")
	}
	if !strings.Contains(w.Body.String(), "https://subs.example.com/sub/alice?format=json") {
		t.Fatal("missing JSON subscription link")
	}
	if !strings.Contains(w.Body.String(), `"settings":{"subURI":"https://subs.example.com/sub/"}`) {
		t.Fatal("public subscription setting missing")
	}
}

func TestSubscriptionBaseNeedsPublicAddress(t *testing.T) {
	_, err := publicSubscriptionBase(map[string]any{"subURI": "http://127.0.0.1:2096/sub/"}, "https://example.com/app/")
	if err == nil {
		t.Fatal("accepted loopback subscription URL")
	}
	base, err := publicSubscriptionBase(map[string]any{"subDomain": "subs.example.com", "subPort": "24321", "subPath": "/secret/", "subCertFile": "/cert.pem", "subKeyFile": "/key.pem"}, "http://127.0.0.1:2095/app/")
	if err != nil || base != "https://subs.example.com:24321/secret/" {
		t.Fatalf("incorrect S-UI string setting projection: %q, %v", base, err)
	}
	if _, err := publicSubscriptionBase(map[string]any{"subURI": "http://subs.example.com/sub/"}, "https://example.com/app/"); err == nil {
		t.Fatal("accepted public plaintext subscription URL")
	}
	if _, err := publicSubscriptionBase(map[string]any{"subURI": "https://192.168.1.1/sub/"}, "https://example.com/app/"); err == nil {
		t.Fatal("accepted private subscription URL")
	}
}
