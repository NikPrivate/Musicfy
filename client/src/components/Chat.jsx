import { useEffect, useRef, useState } from "react";
import { Send, MessageSquare, ChevronDown } from "lucide-react";
import { emit } from "../socket.js";
import Avatar from "./Avatar.jsx";

// Skribbl-style chat panel that lives on the right of the room. During a live
// round it doubles as the guess box: what a still-guessing player types is sent
// as a guess, so correct answers are announced (never shown as text) and wrong
// ones appear as ordinary messages.
export default function Chat({ messages = [], you, isChooser, phase }) {
  const [text, setText] = useState("");
  const [flash, setFlash] = useState(null); // 'correct' | 'close'
  const [showJump, setShowJump] = useState(false); // "new messages" button
  const listRef = useRef(null);
  const atBottomRef = useRef(true); // is the user currently scrolled to the bottom?

  const playing = phase === "playing";
  const youGuessed = !!you?.hasGuessed;
  const guessing = playing && !isChooser && !youGuessed;

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  // Jump to the newest message.
  function scrollToBottom(behavior = "smooth") {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Track whether the user is reading older messages so we don't yank them down.
  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = isNearBottom(el);
    if (atBottomRef.current) setShowJump(false);
  }

  // On a new message: follow along only if already at the bottom; otherwise
  // surface a "New messages" button to jump down.
  // Key off the newest message's id rather than the count: the server caps the
  // feed at 80, so once it's full `length` stops changing and the effect would
  // never fire again.
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom("auto");
    else setShowJump(true);
  }, [lastId]);

  function flashOnce(kind) {
    setFlash(kind);
    setTimeout(() => setFlash((f) => (f === kind ? null : f)), 1600);
  }

  async function send(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    // Sending always pulls you back down to your own message.
    atBottomRef.current = true;
    const res = await emit("chat:send", { text: value });
    if (res?.correct) flashOnce("correct");
    else if (res?.close) flashOnce("close");
  }

  const placeholder = guessing
    ? "Type your guess…"
    : playing && youGuessed
    ? "You got it! Chat away…"
    : playing && isChooser
    ? "Your song — no spoilers!"
    : "Send a message…";

  return (
    <aside className="card chat">
      <h3 className="chat-title">
        <MessageSquare size={16} className="icon-primary" />
        {guessing ? "Guess in chat" : "Chat"}
      </h3>

      <div className="chat-body">
        <div className="chat-messages" ref={listRef} onScroll={onScroll}>
          {messages.length === 0 ? (
            <p className="chat-empty muted">
              {playing ? "Type the song title to guess it!" : "Say hi 👋"}
            </p>
          ) : (
            messages.map((m) => (
              <ChatMessage key={m.id} m={m} youId={you?.clientId} />
            ))
          )}
        </div>
        {showJump && (
          <button
            type="button"
            className="chat-jump"
            onClick={() => scrollToBottom()}
          >
            <ChevronDown size={15} />
            New messages
          </button>
        )}
      </div>

      {flash === "close" && <p className="chat-hint chat-hint--close">So close — keep trying!</p>}
      {flash === "correct" && <p className="chat-hint chat-hint--correct">Correct! 🎉</p>}

      <form
        className={`chat-form ${flash ? `chat-form--${flash}` : ""}`}
        onSubmit={send}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          maxLength={200}
          aria-label={guessing ? "Your guess" : "Chat message"}
        />
        <button
          className="btn btn--primary chat-send"
          type="submit"
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </form>
    </aside>
  );
}

function ChatMessage({ m, youId }) {
  if (m.type === "system") {
    return <div className="chat-msg chat-msg--system">{m.text}</div>;
  }
  if (m.type === "reveal") {
    return <div className="chat-msg chat-msg--reveal">{m.text}</div>;
  }
  if (m.type === "correct") {
    return <div className="chat-msg chat-msg--correct">{m.text}</div>;
  }
  const mine = m.clientId && m.clientId === youId;
  return (
    <div className={`chat-msg chat-msg--chat ${mine ? "is-mine" : ""}`}>
      <Avatar value={m.avatar} size={20} />
      <span className="chat-name">{m.username}:</span>
      <span className="chat-text">{m.text}</span>
    </div>
  );
}
