-- Gör bucketen `support-media` privat. Körs för hand, EFTER security_hardening.sql
-- och först när alla testare har en app med `signSupportMediaUrls`
-- (lib/supportMedia.ts). En äldre app spelar upp den publika URL:en, som
-- slutar fungera i samma stund som det här körs.
--
-- Efteråt kan ingen utan konto hämta ett foto, en röst eller en video, och
-- ingen kan lista bucketen. Läsning går genom signerade länkar, och policyn i
-- security_hardening.sql avgör vem som får signera.

update storage.buckets set public = false where id = 'support-media';
drop policy if exists "Public read support-media" on storage.objects;
