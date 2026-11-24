-- Contact information is independent from authentication. Copy existing verified numbers once to preserve prior operational contacts.
ALTER TABLE resident_profiles ADD COLUMN contact_phone TEXT CHECK (contact_phone IS NULL OR (length(contact_phone) = 11 AND substr(contact_phone, 1, 1) = '1' AND contact_phone NOT GLOB '*[^0-9]*'));
--> statement-breakpoint
INSERT INTO resident_profiles (user_id, contact_phone, created_at, updated_at)
SELECT user_id, phone, created_at, updated_at FROM resident_phone_identities WHERE 1
ON CONFLICT(user_id) DO UPDATE SET contact_phone = excluded.contact_phone;
