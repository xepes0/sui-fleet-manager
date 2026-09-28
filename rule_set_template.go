package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
)

func validateRuleSetApplication(req previewRequest) error {
	return validateTemplate(&templateInput{Name: "rule set", Kind: "rule_set", Payload: req.Object})
}

func previewRuleSetApplication(ctx context.Context, a *app, s server, req previewRequest, c *change) {
	data, err := a.suiGet(ctx, s, "config")
	if err != nil {
		c.Error = err.Error()
		return
	}
	current, ok := configCategory(data, "config").(map[string]any)
	if !ok {
		c.Error = "S-UI returned an invalid core configuration"
		return
	}
	var ruleSet map[string]any
	if err := json.Unmarshal(req.Object, &ruleSet); err != nil {
		c.Error = err.Error()
		return
	}
	updated := cloneMap(current)
	route, _ := updated["route"].(map[string]any)
	if route == nil {
		route = map[string]any{}
	} else {
		route = cloneMap(route)
	}
	var list []any
	if existing, ok := route["rule_set"].([]any); ok {
		list = append([]any{}, existing...)
	}
	for _, entry := range list {
		if object, ok := entry.(map[string]any); ok && object["tag"] == ruleSet["tag"] {
			c.Error = "rule-set tag already exists on panel"
			return
		}
	}
	route["rule_set"] = append(list, ruleSet)
	updated["route"] = route
	c.Before = mustJSON(current)
	c.Fingerprint = fingerprint(c.Before)
	c.After = mustJSON(updated)
}

func executeRuleSetApplication(ctx context.Context, a *app, s server, c change) (string, error) {
	data, err := a.suiGet(ctx, s, "config")
	if err != nil {
		return "", err
	}
	if fingerprint(mustJSON(configCategory(data, "config"))) != c.Fingerprint {
		return "", errors.New("core configuration changed after preview; preview again")
	}
	backup, err := a.backup(ctx, s)
	if err != nil {
		return "", err
	}
	if err := a.suiPost(ctx, s, "save", url.Values{"object": {"config"}, "action": {"edit"}, "data": {string(c.After)}}); err != nil {
		return backup, err
	}
	updated, err := a.suiGet(ctx, s, "config")
	if err != nil {
		return backup, err
	}
	if fingerprint(mustJSON(configCategory(updated, "config"))) != fingerprint(c.After) {
		return backup, errors.New("save accepted, rule-set configuration did not match preview")
	}
	return backup, nil
}
