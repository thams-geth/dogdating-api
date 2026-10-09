CREATE TABLE ops.help_articles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 locale text NOT NULL CHECK(locale='en-IN'),
 slug text NOT NULL CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=80),
 version text NOT NULL CHECK(length(version) BETWEEN 1 AND 60),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 120),
 body text NOT NULL CHECK(length(body) BETWEEN 30 AND 10000),
 review_reference text NOT NULL CHECK(length(review_reference) BETWEEN 5 AND 200),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','retired')),
 created_by_staff uuid NOT NULL REFERENCES ops.staff_accounts(id),
 published_at timestamptz,
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(locale,slug,version)
);
CREATE UNIQUE INDEX one_published_help_article ON ops.help_articles(locale,slug) WHERE state='published';
CREATE FUNCTION ops.protect_help_article() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'draft' AND (NEW.locale,NEW.slug,NEW.version,NEW.title,NEW.body,NEW.review_reference,NEW.created_by_staff)
   IS DISTINCT FROM (OLD.locale,OLD.slug,OLD.version,OLD.title,OLD.body,OLD.review_reference,OLD.created_by_staff) THEN
  RAISE EXCEPTION 'published help content is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_help_article BEFORE UPDATE ON ops.help_articles FOR EACH ROW EXECUTE FUNCTION ops.protect_help_article();
