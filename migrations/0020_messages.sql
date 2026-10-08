ALTER TABLE meetup.messages ADD COLUMN client_message_id uuid;
CREATE UNIQUE INDEX messages_client_retry ON meetup.messages(conversation_id,sender_user_id,client_message_id);
ALTER TABLE meetup.conversation_members ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE TABLE meetup.conversation_keys (
 conversation_id uuid PRIMARY KEY REFERENCES meetup.conversations(id) ON DELETE CASCADE,
 wrapped_key bytea NOT NULL
);
CREATE TABLE meetup.realtime_tickets (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES identity.sessions(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
 consumed_at timestamptz
);
CREATE INDEX realtime_tickets_user_created ON meetup.realtime_tickets(user_id,created_at);
