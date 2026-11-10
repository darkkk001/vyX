-- Staff permission CRM (owner 2026-11-10): the CRM screens were open to every MANAGER; they now need the CRM permission.
-- So that no current manager loses CRM access, every MANAGER that exists now is granted it. From here on it is a toggle
-- for new or changed staff. Data only, idempotent (a manager who already holds it is left alone).
-- Revert (only if the code is reverted too): UPDATE "AdminUser" SET "extraPermissions" = array_remove("extraPermissions", 'CRM') WHERE "role" = 'MANAGER';
UPDATE "AdminUser"
SET "extraPermissions" = array_append("extraPermissions", 'CRM')
WHERE "role" = 'MANAGER' AND NOT ('CRM' = ANY("extraPermissions"));
