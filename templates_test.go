package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestTemplateSecretsEncryptedAndExcludedFromList(t *testing.T) {
	a := testApp(t)
	if err := initializeTemplateStore(a.db); err != nil {
		t.Fatal(err)
	}
	input := templateInput{Name: "US SOCKS", Kind: "outbound", Payload: json.RawMessage(`{"type":"socks","tag":"us","server":"example.com","server_port":1080,"password":"secret-marker"}`)}
	w := postJSON(t, a.templatesHandler, "/api/templates", input)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created savedTemplate
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	var ciphertext string
	if err := a.db.QueryRow(`SELECT payload_cipher FROM templates WHERE id=?`, created.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ciphertext, "secret-marker") {
		t.Fatal("template secret stored in plaintext")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/templates", nil)
	list := httptest.NewRecorder()
	a.templatesHandler(list, request)
	if list.Code != 200 || bytes.Contains(list.Body.Bytes(), []byte("secret-marker")) {
		t.Fatalf("list leaked payload: %d %s", list.Code, list.Body.String())
	}
	detail := httptest.NewRecorder()
	a.templateHandler(detail, httptest.NewRequest(http.MethodGet, "/api/templates/"+strconv.FormatInt(created.ID, 10), nil))
	if detail.Code != 200 || !bytes.Contains(detail.Body.Bytes(), []byte("secret-marker")) {
		t.Fatalf("detail missing template: %d %s", detail.Code, detail.Body.String())
	}
}

func TestTemplateRejectsInternalRuleSetURL(t *testing.T) {
	for _, raw := range []string{
		`{"type":"remote","tag":"private","format":"binary","url":"http://example.com/rs.srs"}`,
		`{"type":"remote","tag":"private","format":"binary","url":"https://127.0.0.1/rs.srs"}`,
		`{"type":"remote","tag":"private","format":"binary","url":"https://internal.local/rs.srs"}`,
	} {
		input := templateInput{Name: "bad", Kind: "rule_set", Payload: json.RawMessage(raw)}
		if err := validateTemplate(&input); err == nil {
			t.Fatalf("accepted internal URL: %s", raw)
		}
	}
}
