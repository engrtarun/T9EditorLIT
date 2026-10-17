package vault

import (
	"testing"

	"github.com/gotd/td/tg"
)

// The destination string is whatever the user has in front of them — a handle,
// a pasted link, an id out of a bot. Every form below has to land on the same
// chat, and the ones that do not must fail loudly rather than posting the video
// somewhere unexpected.
func TestParseTarget(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  chatTarget
	}{
		{"self", "me", chatTarget{kind: targetSelf}},
		{"self alias", "self", chatTarget{kind: targetSelf}},
		{"saved messages", "SavedMessages", chatTarget{kind: targetSelf}},
		{"username with at", "@tgwebcloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"bare username", "tgwebcloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"username is lower cased", "@TGWebCloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"t.me link", "https://t.me/tgwebcloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"t.me link without scheme", "t.me/tgwebcloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"http link", "http://t.me/tgwebcloud1", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"link with single-use query", "https://t.me/tgwebcloud1?single", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"link with start query", "https://t.me/tgwebcloud1?start=abc", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"surrounding space", "  @tgwebcloud1 ", chatTarget{kind: targetUsername, username: "tgwebcloud1"}},
		{"invite plus", "https://t.me/+AbCdEfGh", chatTarget{kind: targetInvite, invite: "AbCdEfGh"}},
		{"invite joinchat", "https://t.me/joinchat/AbCdEfGh", chatTarget{kind: targetInvite, invite: "AbCdEfGh"}},
		{"invite bare plus", "+AbCdEfGh", chatTarget{kind: targetInvite, invite: "AbCdEfGh"}},
		{"negative channel id", "-1001234567890", chatTarget{kind: targetID, id: -1001234567890}},
		{"bare channel id", "1234567890", chatTarget{kind: targetID, id: 1234567890}},
		{"user id", "55512345", chatTarget{kind: targetID, id: 55512345}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseTarget(tt.input)
			if err != nil {
				t.Fatalf("ParseTarget(%q): %v", tt.input, err)
			}
			if got.kind != tt.want.kind {
				t.Fatalf("kind = %v, want %v", got.kind, tt.want.kind)
			}
			switch tt.want.kind {
			case targetUsername:
				if got.username != tt.want.username {
					t.Errorf("username = %q, want %q", got.username, tt.want.username)
				}
			case targetID:
				if got.id != tt.want.id {
					t.Errorf("id = %d, want %d", got.id, tt.want.id)
				}
			case targetInvite:
				if got.invite != tt.want.invite {
					t.Errorf("invite = %q, want %q", got.invite, tt.want.invite)
				}
			}
		})
	}
}

// A target that cannot be understood must fail here, not three parts into a 5 GB
// upload. An invite link with no hash and a stray path are both common typos.
func TestParseTargetRejectsGarbage(t *testing.T) {
	for _, input := range []string{
		"",
		"   ",
		"https://t.me/",
		"https://t.me/+",
		"https://t.me/joinchat/",
		"some/random/path",
	} {
		if got, err := ParseTarget(input); err == nil {
			t.Errorf("ParseTarget(%q) = %+v, want an error", input, got)
		}
	}
}

func TestChatTargetString(t *testing.T) {
	tests := map[string]chatTarget{
		"me":              {kind: targetSelf},
		"@tgwebcloud1":    {kind: targetUsername, username: "tgwebcloud1"},
		"-1001234567890":  {kind: targetID, id: -1001234567890},
		"invite:AbCdEfGh": {kind: targetInvite, invite: "AbCdEfGh"},
	}
	for want, target := range tests {
		if got := target.String(); got != want {
			t.Errorf("String() = %q, want %q", got, want)
		}
	}
}

// Telegram prefixes message links with -100, but channels.getChannels wants the
// bare id. Getting this wrong silently resolves to nothing.
func TestChannelIDFromPeerID(t *testing.T) {
	tests := []struct {
		in   int64
		want int64
		ok   bool
	}{
		{-1001234567890, 1234567890, true},
		{1234567890, 1234567890, true},
		{-1001234567890123, 1234567890123, true},
		{55512345, 0, false}, // a person, not a channel
		{0, 0, false},        // meaningless
		{-5, 0, false},       // a small group chat id
	}

	for _, tt := range tests {
		got, ok := channelIDFromPeerID(tt.in)
		if ok != tt.ok || (ok && got != tt.want) {
			t.Errorf("channelIDFromPeerID(%d) = (%d, %v), want (%d, %v)",
				tt.in, got, ok, tt.want, tt.ok)
		}
	}
}

// The access hash is the part that cannot be derived. A resolver that returns a
// peer without it would fail later, at send time, after the whole file is
// hashed — so the conversion refuses instead.
func TestInputPeerFrom(t *testing.T) {
	chats := []tg.ChatClass{
		&tg.Channel{ID: 1234567890, AccessHash: 999, Username: "cloud"},
		&tg.Chat{ID: 42},
	}
	users := []tg.UserClass{
		&tg.User{ID: 777, AccessHash: 555, Username: "tarun"},
	}

	t.Run("channel keeps its hash", func(t *testing.T) {
		got, err := inputPeerFrom(&tg.PeerChannel{ChannelID: 1234567890}, chats, users)
		if err != nil {
			t.Fatal(err)
		}
		peer, ok := got.input.(*tg.InputPeerChannel)
		if !ok {
			t.Fatalf("input = %T, want *tg.InputPeerChannel", got.input)
		}
		if peer.AccessHash != 999 || peer.ChannelID != 1234567890 {
			t.Errorf("peer = %+v", peer)
		}
		if got.username != "cloud" {
			t.Errorf("username = %q, want cloud (t.me links need it)", got.username)
		}
	})

	t.Run("basic group needs no hash", func(t *testing.T) {
		got, err := inputPeerFrom(&tg.PeerChat{ChatID: 42}, chats, users)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := got.input.(*tg.InputPeerChat); !ok {
			t.Fatalf("input = %T, want *tg.InputPeerChat", got.input)
		}
	})

	t.Run("user keeps its hash", func(t *testing.T) {
		got, err := inputPeerFrom(&tg.PeerUser{UserID: 777}, chats, users)
		if err != nil {
			t.Fatal(err)
		}
		peer, ok := got.input.(*tg.InputPeerUser)
		if !ok {
			t.Fatalf("input = %T, want *tg.InputPeerUser", got.input)
		}
		if peer.AccessHash != 555 {
			t.Errorf("access hash = %d, want 555", peer.AccessHash)
		}
	})

	t.Run("missing hash is an error, not a broken peer", func(t *testing.T) {
		if _, err := inputPeerFrom(&tg.PeerChannel{ChannelID: 1}, nil, nil); err == nil {
			t.Fatal("expected an error when the channel is absent from the response")
		}
	})
}

// The message id is the only handle the user has on an uploaded part, and it
// arrives in different containers depending on where it was posted.
func TestFirstMessageID(t *testing.T) {
	msg := func(id int) *tg.Message { return &tg.Message{ID: id} }

	tests := map[string]struct {
		updates tg.UpdatesClass
		want    int
	}{
		"channel message": {updates: &tg.UpdateShort{Update: &tg.UpdateNewChannelMessage{Message: msg(77)}}, want: 77},
		"chat message":    {updates: &tg.UpdateShort{Update: &tg.UpdateNewMessage{Message: msg(78)}}, want: 78},
		"sent message":    {updates: &tg.UpdateShortSentMessage{ID: 79}, want: 79},
		"updates list": {updates: &tg.Updates{Updates: []tg.UpdateClass{
			&tg.UpdateNewMessage{Message: msg(80)},
		}}, want: 80},
		"combined list": {updates: &tg.UpdatesCombined{Updates: []tg.UpdateClass{
			&tg.UpdateNewChannelMessage{Message: msg(81)},
		}}, want: 81},
		"nothing usable": {updates: &tg.UpdatesTooLong{}, want: 0},
		"nil":            {updates: nil, want: 0},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			if got := firstMessageID(tt.updates); got != tt.want {
				t.Errorf("firstMessageID = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestPeerFromUpdatesPrefersChatOverUser(t *testing.T) {
	res := &tg.Updates{
		Chats: []tg.ChatClass{&tg.Channel{ID: 5, AccessHash: 6, Username: "six"}},
		Users: []tg.UserClass{&tg.User{ID: 9, AccessHash: 10}},
	}

	got, ok := peerFromUpdates(res)
	if !ok {
		t.Fatal("expected a peer")
	}
	if _, isChannel := got.input.(*tg.InputPeerChannel); !isChannel {
		t.Fatalf("input = %T, want the channel", got.input)
	}
}

func TestOldestTopMessage(t *testing.T) {
	dialogs := []tg.DialogClass{
		&tg.Dialog{TopMessage: 300},
		&tg.Dialog{TopMessage: 100},
		&tg.Dialog{TopMessage: 200},
		&tg.Dialog{TopMessage: 0}, // a chat with no messages
	}
	if got := oldestTopMessage(dialogs); got != 100 {
		t.Errorf("oldestTopMessage = %d, want 100 (paging cursor)", got)
	}
	if got := oldestTopMessage(nil); got != 0 {
		t.Errorf("oldestTopMessage(nil) = %d, want 0", got)
	}
}
