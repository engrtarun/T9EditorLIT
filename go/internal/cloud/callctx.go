// Package cloud — callctx.go: per-request metadata that travels with a
// provider call, without ever reaching the provider.
//
// The recorder observes every call through UsageTransport, but the transport
// only sees an http.Request. The operation name ("transcribe", "correct",
// "analyze", "merge"), the model id and the account id are not on the wire
// — and putting them in headers would risk leaking them to the provider.
// Instead they ride in the request's context.Context via WithCallMeta, which
// the transport reads back. A provider never sees them.
package cloud

import "context"

// CallMeta is the "what and who" of one provider request.
//
// Op names the operation the daemon is performing; Model and KeyID name the
// provider model and the account that served it; AudioSecs is the audio
// duration the call actually processed (0 when not applicable, e.g. a chat
// call). All fields are optional — a missing value is recorded as empty/zero,
// never invented.
type CallMeta struct {
	Op        string
	Model     string
	KeyID     string
	AudioSecs float64
}

type callMetaKey struct{}

// WithCallMeta returns a context carrying meta. A nil meta is a no-op, so
// callers can pass a value unconditionally.
func WithCallMeta(ctx context.Context, meta CallMeta) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, callMetaKey{}, meta)
}

// CallMetaFrom reads the meta a caller attached. The second return is false
// when nothing was attached — callers should treat that as "unknown", never
// as a zero-value guess.
func CallMetaFrom(ctx context.Context) (CallMeta, bool) {
	if ctx == nil {
		return CallMeta{}, false
	}
	v, ok := ctx.Value(callMetaKey{}).(CallMeta)
	return v, ok
}

// MergeCallMeta fills only the empty fields of the meta already on ctx with the
// supplied patch, so a client can add its model/account without clobbering the
// operation name or audio duration the caller attached higher up.
func MergeCallMeta(ctx context.Context, patch CallMeta) context.Context {
	meta, _ := CallMetaFrom(ctx)
	if meta.Op == "" {
		meta.Op = patch.Op
	}
	if meta.Model == "" {
		meta.Model = patch.Model
	}
	if meta.KeyID == "" {
		meta.KeyID = patch.KeyID
	}
	if meta.AudioSecs == 0 {
		meta.AudioSecs = patch.AudioSecs
	}
	return WithCallMeta(ctx, meta)
}
