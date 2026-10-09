ALTER TABLE identity.privacy_requests ADD COLUMN export_scope text CHECK(export_scope IS NULL OR export_scope='account_data_v1');
CREATE INDEX privacy_export_queue ON identity.privacy_requests(created_at) WHERE kind='export' AND state='queued';
