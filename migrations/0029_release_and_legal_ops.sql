ALTER TABLE ops.staff_accounts DROP CONSTRAINT staff_accounts_roles_check;
ALTER TABLE ops.staff_accounts ADD CONSTRAINT staff_accounts_roles_check CHECK(roles<@ARRAY['moderator','support','appeals','city_ops','operations','reviewer','release_ops','legal_ops']::text[]);
CREATE TABLE ops.app_release_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL DEFAULT 1,
 policy jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid REFERENCES ops.staff_accounts(id)
);
INSERT INTO ops.app_release_policy(singleton,policy) VALUES(true,'{"revision":"2026-10-07.1","maintenance":false,"android":{"minimumBuild":1,"latestBuild":1,"storeUrl":null},"ios":{"minimumBuild":1,"latestBuild":1,"storeUrl":null}}');
ALTER TABLE identity.policy_documents ADD COLUMN review_reference text,ADD COLUMN created_by_staff uuid REFERENCES ops.staff_accounts(id);
