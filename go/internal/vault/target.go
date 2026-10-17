package vault

// target.go — turning "where should this go?" into a Telegram peer.
//
// The destination is configured as a single string (TELEGRAM_TARGET_CHAT), and
// the user will type whatever they have in front of them: a channel username
// with or without the @, a t.me link someone pasted into chat, the -100… id
// from a bot, or an invite link for a private channel. Resolving that is the
// first thing an upload can get wrong, and it is worth doing exactly once,
// clearly, instead of discovering the format halfway through a 5 GB send.
//
// parseTarget is pure and lives here so the accepted formats are testable
// without a network connection; resolvePeer is the part that talks to Telegram.

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/gotd/td/tg"
)

// targetKind is the shape of a configured destination.
type targetKind int

const (
	targetSelf targetKind = iota
	targetUsername
	targetID
	targetInvite
)

// chatTarget is a parsed destination string.
type chatTarget struct {
	kind targetKind
	// Username without the leading @, lower-cased.
	username string
	// Numeric Telegram peer id exactly as the user wrote it (may be a
	// -100… channel id or a bare user id).
	id int64
	// Invite hash from t.me/+hash or t.me/joinchat/hash.
	invite string
}

// String renders the target back for logs and for the UI to display.
func (t chatTarget) String() string {
	switch t.kind {
	case targetSelf:
		return "me"
	case targetUsername:
		return "@" + t.username
	case targetID:
		return strconv.FormatInt(t.id, 10)
	case targetInvite:
		return "invite:" + t.invite
	default:
		return ""
	}
}

// ParseTarget understands every destination form a user realistically pastes.
//
// The order matters: an invite link and a username look alike until the `+` or
// the `joinchat/` segment is checked, and a bare "12345" is an id rather than a
// username because Telegram usernames may not be all digits.
func ParseTarget(s string) (chatTarget, error) {
	raw := strings.TrimSpace(s)
	if raw == "" {
		return chatTarget{}, fmt.Errorf("no Telegram chat configured; set TELEGRAM_TARGET_CHAT (@channel, channel id, invite link, or \"me\")")
	}

	// Strip a URL down to whatever follows t.me/ — the scheme and host are
	// noise, and t.me is the only host Telegram ever uses for these links.
	lowered := strings.ToLower(raw)
	for _, prefix := range []string{"https://t.me/", "http://t.me/", "t.me/", "telegram.me/"} {
		if strings.HasPrefix(lowered, prefix) {
			rest := raw[len(prefix):]
			// A link may carry a query (?start= for groups, ?single for
			// channels); the username is everything before it.
			if i := strings.IndexAny(rest, "?#"); i >= 0 {
				rest = rest[:i]
			}
			raw = rest
			lowered = strings.ToLower(raw)
			break
		}
	}
	// A pasted link sometimes keeps the host because of autocorrect:
	// "https://t.me/x" is handled above; "telegram.dog/x" is not a Telegram
	// link and should not be guessed at.

	if raw == "" {
		return chatTarget{}, fmt.Errorf("%q has no path after the host", s)
	}

	switch lowered {
	case "me", "self", "myself", "saved", "savedmessages":
		return chatTarget{kind: targetSelf}, nil
	}

	// Invite links: t.me/+AbCdEf or t.me/joinchat/AbCdEf.
	if strings.HasPrefix(lowered, "+") {
		hash := raw[1:]
		if hash == "" {
			return chatTarget{}, fmt.Errorf("%q is an invite link with no hash", s)
		}
		return chatTarget{kind: targetInvite, invite: hash}, nil
	}
	if strings.HasPrefix(lowered, "joinchat/") {
		hash := raw[len("joinchat/"):]
		if hash == "" {
			return chatTarget{}, fmt.Errorf("%q is an invite link with no hash", s)
		}
		return chatTarget{kind: targetInvite, invite: hash}, nil
	}

	if strings.HasPrefix(raw, "@") {
		raw = raw[1:]
	}
	if strings.ContainsAny(raw, "/ ") {
		return chatTarget{}, fmt.Errorf("%q is not a Telegram username, id or invite link", s)
	}

	// An all-digit value is an id. Usernames can look numeric, but Telegram
	// reserves pure numbers for ids, so this ordering matches the server.
	if id, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return chatTarget{kind: targetID, id: id}, nil
	}

	return chatTarget{kind: targetUsername, username: strings.ToLower(raw)}, nil
}

// resolvedPeer is a chat that can be posted to, plus what we learned about it
// on the way.
type resolvedPeer struct {
	// input is what goes into every messages.sendMedia request.
	input tg.InputPeerClass
	// username is the public @name, used to build t.me links. Empty for a
	// private chat, where no such link exists.
	username string
}

// resolvePeer turns a parsed target into a postable chat.
//
// Resolution is cached by the caller, so this may be called more than once for
// the same string but must stay free of hidden state of its own.
func resolvePeer(ctx context.Context, api *tg.Client, t chatTarget) (resolvedPeer, error) {
	switch t.kind {
	case targetSelf:
		return resolvedPeer{input: &tg.InputPeerSelf{}}, nil

	case targetUsername:
		res, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{
			Username: t.username,
		})
		if err != nil {
			return resolvedPeer{}, fmt.Errorf("resolving @%s: %w", t.username, err)
		}
		peer, err := inputPeerFrom(res.Peer, res.Chats, res.Users)
		if err != nil {
			return resolvedPeer{}, fmt.Errorf("@%s resolved to an unusable peer: %w", t.username, err)
		}
		return peer, nil

	case targetInvite:
		res, err := api.MessagesImportChatInvite(ctx, t.invite)
		if err != nil {
			return resolvedPeer{}, fmt.Errorf("joining invite link: %w", err)
		}
		if peer, ok := peerFromUpdates(res); ok {
			return peer, nil
		}
		// The join worked but the response did not name the chat. Fall back to
		// the dialog list, where the new chat now lives.
		return findPeerInDialogs(ctx, api, nil)

	case targetID:
		return resolvePeerByID(ctx, api, t.id)

	default:
		return resolvedPeer{}, fmt.Errorf("unknown target kind")
	}
}

// resolvePeerByID handles the numeric forms.
//
// A channel id (-100… or the bare 1000… form) is looked up through
// channels.getChannels, which is the only call that hands back the access hash
// a private chat needs. When that fails — the usual case for a private channel
// nobody is a member of — the dialog list is searched, because Telegram only
// reveals access hashes for chats this account can already see.
func resolvePeerByID(ctx context.Context, api *tg.Client, id int64) (resolvedPeer, error) {
	if channelID, ok := channelIDFromPeerID(id); ok {
		res, err := api.ChannelsGetChannels(ctx, []tg.InputChannelClass{
			&tg.InputChannel{ChannelID: channelID, AccessHash: 0},
		})
		if err == nil {
			if peer, ok := firstPeerFrom(res.GetChats(), nil); ok {
				return peer, nil
			}
		}
	}

	// A positive, small id is a person (Saved Messages is the account itself).
	if id > 0 {
		res, err := api.UsersGetUsers(ctx, []tg.InputUserClass{
			&tg.InputUser{UserID: id, AccessHash: 0},
		})
		if err == nil {
			if peer, ok := firstPeerFrom(nil, res); ok {
				return peer, nil
			}
		}
	}

	peer, err := findPeerInDialogs(ctx, api, &id)
	if err != nil {
		return resolvedPeer{}, fmt.Errorf("cannot reach chat %d: %w (is this account a member of it?)", id, err)
	}
	return peer, nil
}

// channelIDFromPeerID strips the -100 marker Telegram puts in front of channel
// ids in message links: t.me/c/1234 links carry -1001234, the API wants 1234.
//
// Only that exact shape is converted. -1001… is a small negative id (a basic
// group), not a channel, and converting it would resolve to a chat that does not
// exist.
func channelIDFromPeerID(id int64) (int64, bool) {
	if id < 0 {
		digits := strconv.FormatInt(id, 10)[1:] // drop the minus sign
		if !strings.HasPrefix(digits, "100") {
			return 0, false
		}
		rest := digits[len("100"):]
		if len(rest) < 9 {
			return 0, false
		}
		n, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}

	// Channel ids are nine digits or more; anything smaller is a person or a
	// basic group, which has no -100 form and needs no conversion.
	if id >= 1_000_000_000 {
		return id, true
	}
	return 0, false
}

// maxDialogPages bounds the fallback scan.
//
// The dialog list is a last resort, not the happy path, and walking all of a
// heavy account's dialogs would cost minutes before the user sees any error.
const maxDialogPages = 5
const dialogsPerPage = 100

// findPeerInDialogs walks the recent dialogs looking for a peer id.
//
// want == nil means "take whatever the most recent chat is", which is what an
// invite-link join needs: the joined chat is the newest one.
func findPeerInDialogs(ctx context.Context, api *tg.Client, want *int64) (resolvedPeer, error) {
	var (
		offsetID   int
		offsetDate int
	)

	for page := 0; page < maxDialogPages; page++ {
		res, err := api.MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
			OffsetDate: offsetDate,
			OffsetID:   offsetID,
			Limit:      dialogsPerPage,
		})
		if err != nil {
			return resolvedPeer{}, fmt.Errorf("reading the chat list: %w", err)
		}

		var chats []tg.ChatClass
		var users []tg.UserClass
		var dialogs []tg.DialogClass
		switch v := res.(type) {
		case *tg.MessagesDialogs:
			chats, users, dialogs = v.Chats, v.Users, v.Dialogs
		case *tg.MessagesDialogsSlice:
			chats, users, dialogs = v.Chats, v.Users, v.Dialogs
		default:
			return resolvedPeer{}, fmt.Errorf("unexpected dialogs response %T", res)
		}

		if want == nil && len(chats) > 0 {
			if peer, ok := firstPeerFrom(chats, users); ok {
				return peer, nil
			}
		}
		for _, c := range chats {
			if want != nil && chatIDOf(c) == *want {
				if peer, ok := firstPeerFrom([]tg.ChatClass{c}, nil); ok {
					return peer, nil
				}
			}
		}
		for _, u := range users {
			if want != nil && userIDOf(u) == *want {
				if peer, ok := firstPeerFrom(nil, []tg.UserClass{u}); ok {
					return peer, nil
				}
			}
		}

		if len(dialogs) == 0 {
			break
		}
		// Dialogs are newest-first, so the oldest top message on this page
		// becomes the next page's offset.
		offsetID = oldestTopMessage(dialogs)
		if offsetID == 0 {
			break
		}
		for _, d := range dialogs {
			offsetDate = maxInt(offsetDate, topMessageDate(d))
		}
	}
	return resolvedPeer{}, fmt.Errorf("not found in the last %d chats", maxDialogPages*dialogsPerPage)
}

// topMessageDate is not exposed per dialog, so the date offset is left alone
// unless the caller supplied one. Kept as a named no-op so the paging loop reads
// the same shape as every other paged call in the file.
func topMessageDate(tg.DialogClass) int { return 0 }

// ── pure conversions ─────────────────────────────────────────────────────
// Everything below takes already-decoded Telegram structures and produces an
// input peer. Keeping them free of RPC calls is what makes the awkward cases
// (a peer with no access hash, a supergroup id in -100 form) testable.

func inputPeerFrom(peer tg.PeerClass, chats []tg.ChatClass, users []tg.UserClass) (resolvedPeer, error) {
	switch p := peer.(type) {
	case *tg.PeerUser:
		for _, u := range users {
			if m, ok := u.(*tg.User); ok && m.ID == p.UserID {
				return inputPeerForUser(m), nil
			}
		}
		return resolvedPeer{}, fmt.Errorf("user %d came back without its access hash", p.UserID)
	case *tg.PeerChat:
		for _, c := range chats {
			if m, ok := c.(*tg.Chat); ok && m.ID == p.ChatID {
				return resolvedPeer{input: &tg.InputPeerChat{ChatID: m.ID}}, nil
			}
		}
		return resolvedPeer{}, fmt.Errorf("chat %d came back without its access hash", p.ChatID)
	case *tg.PeerChannel:
		for _, c := range chats {
			if m, ok := c.(*tg.Channel); ok && m.ID == p.ChannelID {
				return inputPeerForChannel(m), nil
			}
		}
		return resolvedPeer{}, fmt.Errorf("channel %d came back without its access hash", p.ChannelID)
	default:
		return resolvedPeer{}, fmt.Errorf("unexpected peer type %T", peer)
	}
}

func inputPeerForChannel(c *tg.Channel) resolvedPeer {
	if c == nil {
		return resolvedPeer{}
	}
	return resolvedPeer{
		input:    &tg.InputPeerChannel{ChannelID: c.ID, AccessHash: c.AccessHash},
		username: c.Username,
	}
}

func inputPeerForUser(u *tg.User) resolvedPeer {
	if u == nil {
		return resolvedPeer{}
	}
	return resolvedPeer{
		input:    &tg.InputPeerUser{UserID: u.ID, AccessHash: u.AccessHash},
		username: u.Username,
	}
}

// firstPeerFrom picks the first usable chat or user out of a decoded response.
func firstPeerFrom(chats []tg.ChatClass, users []tg.UserClass) (resolvedPeer, bool) {
	for _, c := range chats {
		switch m := c.(type) {
		case *tg.Channel:
			return inputPeerForChannel(m), true
		case *tg.Chat:
			return resolvedPeer{input: &tg.InputPeerChat{ChatID: m.ID}}, true
		}
	}
	for _, u := range users {
		if m, ok := u.(*tg.User); ok {
			return inputPeerForUser(m), true
		}
	}
	return resolvedPeer{}, false
}

func chatIDOf(c tg.ChatClass) int64 {
	switch m := c.(type) {
	case *tg.Channel:
		return m.ID
	case *tg.Chat:
		return m.ID
	default:
		return 0
	}
}

func userIDOf(u tg.UserClass) int64 {
	if m, ok := u.(*tg.User); ok {
		return m.ID
	}
	return 0
}

// oldestTopMessage is the paging cursor: dialogs come back newest-first, so the
// smallest top message id on the page is the oldest one still unseen.
func oldestTopMessage(dialogs []tg.DialogClass) int {
	oldest := 0
	for _, d := range dialogs {
		dlg, ok := d.(*tg.Dialog)
		if !ok || dlg.TopMessage <= 0 {
			continue
		}
		if oldest == 0 || dlg.TopMessage < oldest {
			oldest = dlg.TopMessage
		}
	}
	return oldest
}

// peerFromUpdates digs a peer out of any Updates response.
//
// Telegram hands back chats and users in different containers depending on the
// call, so this walks the shapes that actually carry them rather than guessing
// one. It reports false when nothing usable is present, which the callers treat
// as "fall back to the dialog list", not as an error.
func peerFromUpdates(u tg.UpdatesClass) (resolvedPeer, bool) {
	switch v := u.(type) {
	case *tg.Updates:
		return firstPeerFrom(v.Chats, v.Users)
	case *tg.UpdatesCombined:
		return firstPeerFrom(v.Chats, v.Users)
	case *tg.UpdateShort:
		// A short update carries a message but no chat list; the message's
		// peer is all there is.
		switch m := v.Update.(type) {
		case *tg.UpdateNewMessage:
			if msg, ok := m.Message.(*tg.Message); ok {
				return inputPeerFromPeerClass(msg.PeerID), true
			}
		case *tg.UpdateNewChannelMessage:
			if msg, ok := m.Message.(*tg.Message); ok {
				return inputPeerFromPeerClass(msg.PeerID), true
			}
		}
	}
	return resolvedPeer{}, false
}

// inputPeerFromPeerClass converts a peer reference into an input peer using
// only the fields Telegram repeats inside the message itself. Channel and user
// messages carry PeerUser/PeerChannel without access hashes, so this is only
// used where the caller has already learned the hash elsewhere.
func inputPeerFromPeerClass(peer tg.PeerClass) resolvedPeer {
	switch p := peer.(type) {
	case *tg.PeerUser:
		return resolvedPeer{input: &tg.InputPeerUser{UserID: p.UserID}}
	case *tg.PeerChat:
		return resolvedPeer{input: &tg.InputPeerChat{ChatID: p.ChatID}}
	case *tg.PeerChannel:
		return resolvedPeer{input: &tg.InputPeerChannel{ChannelID: p.ChannelID}}
	default:
		return resolvedPeer{}
	}
}

// firstMessageID digs the new message id out of what Telegram returns.
//
// Sending to a channel comes back as UpdateNewChannelMessage; sending to a
// chat comes back as UpdateShortSentMessage, which carries the id directly.
// Getting this wrong is not cosmetic: it is the only handle the user has on
// the uploaded part.
func firstMessageID(u tg.UpdatesClass) int {
	if u == nil {
		return 0
	}

	fromUpdate := func(item tg.UpdateClass) int {
		switch v := item.(type) {
		case *tg.UpdateNewMessage:
			if m, ok := v.Message.(*tg.Message); ok {
				return m.ID
			}
		case *tg.UpdateNewChannelMessage:
			if m, ok := v.Message.(*tg.Message); ok {
				return m.ID
			}
		}
		return 0
	}
	fromList := func(items []tg.UpdateClass) int {
		for _, item := range items {
			if id := fromUpdate(item); id != 0 {
				return id
			}
		}
		return 0
	}

	switch v := u.(type) {
	case *tg.UpdateShortSentMessage:
		return v.ID
	case *tg.UpdateShort:
		return fromUpdate(v.Update)
	case *tg.Updates:
		return fromList(v.Updates)
	case *tg.UpdatesCombined:
		return fromList(v.Updates)
	}
	return 0
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
