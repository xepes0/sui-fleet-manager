package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"syscall"
	"time"
)

func transientVerificationRead(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary())
}

// Saving can restart the proxy core hosting a panel's public fallback listener.
// Reconnect only the verification GET; a mutation must never be replayed.
func (a *app) suiGetAfterSave(ctx context.Context, s server, endpoint string) (map[string]any, error) {
	delays := []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second}
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value, err := a.suiGet(ctx, s, endpoint)
		if err == nil {
			if attempt > 0 {
				log.Printf("S-UI server %d verification reconnected after %d read attempts", s.ID, attempt+1)
			}
			return value, nil
		}
		if !transientVerificationRead(err) || attempt == len(delays) {
			return nil, err
		}
		a.client.CloseIdleConnections()
		timer := time.NewTimer(delays[attempt])
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
