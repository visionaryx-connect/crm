-- Two-factor authentication is optional by default. Roles can still require it (Users & roles → edit role).
UPDATE roles SET requires_mfa = 0, updated_at = '2026-10-15T00:00:00.000Z';
