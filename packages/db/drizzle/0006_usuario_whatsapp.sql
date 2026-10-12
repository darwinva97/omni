-- El nombre de usuario de WhatsApp (@usuario) de un contacto.
--
-- Es el tercer nombre en el orden de preferencia: después del que TÚ le
-- pusiste y del que esa persona se puso a sí misma, y antes del número. Con
-- los LID, muchos contactos no tienen número visible, y sin esto la única
-- alternativa era enseñar el identificador.
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "username" text;
