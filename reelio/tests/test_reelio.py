import os
import shutil
import tempfile
import unittest
from unittest import mock

os.environ["REELIO_DATA"] = tempfile.mkdtemp()

from reelio import audio, connectors, copywriter, llm, publisher, reel, scenario, store, visuals  # noqa: E402


class CopywriterTests(unittest.TestCase):
    def test_hashtag_nettoyage(self):
        self.assertEqual(copywriter.clean_hashtag(" #Café Créatif!"), "#CaféCréatif")
        self.assertEqual(copywriter.clean_hashtag("###"), "")

    def test_limites_x_hashtags_inclus(self):
        raw = {"texte": "a" * 500, "hashtags": ["web", "app", "design"]}
        post = copywriter._normalize("x", raw)
        self.assertLessEqual(len(post.full_text()), 280)
        self.assertEqual(len(post.hashtags), 2)

    def test_modele_indisponible_donne_brouillons(self):
        with mock.patch.object(llm, "ask", side_effect=llm.LLMUnavailable("hors ligne")):
            posts, warning = copywriter.generate("Lancer son site web", ["facebook", "x"])
        self.assertEqual(set(posts), {"facebook", "x"})
        self.assertIn("Aucun modèle", warning)

    def test_reponse_modele_valide(self):
        rep = '{"tiktok": {"texte": "Salut !", "hashtags": ["#web", "#web", "app"]}}'
        with mock.patch.object(llm, "ask", return_value=rep):
            posts, warning = copywriter.generate("idée", ["tiktok", "instagram"])
        self.assertEqual(posts["tiktok"].hashtags, ["#web", "#app"])
        self.assertIn("instagram", warning)


class StoreExportTests(unittest.TestCase):
    def test_cycle_publication(self):
        pid = store.add_post("idée", "facebook", "Bonjour", ["#web"], "")
        store.update_post(pid, status="approuve")
        self.assertEqual(store.get_post(pid)["status"], "approuve")
        with self.assertRaises(ValueError):
            store.update_post(pid, status="inconnu")
        dossier = publisher.export_post(pid)
        self.assertIn("Bonjour", (dossier / "publication.txt").read_text(encoding="utf-8"))
        self.assertEqual(store.get_post(pid)["status"], "exporte")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg absent")
class ReelTests(unittest.TestCase):
    def test_reel_mp4(self):
        out = reel.make_reel(["Bonjour", "Voici Reelio"], os.path.join(os.environ["REELIO_DATA"], "t.mp4"),
                             seconds_per_slide=1)
        self.assertGreater(out.stat().st_size, 1000)

    def test_reel_vide(self):
        with self.assertRaises(ValueError):
            reel.make_reel([" "], "x.mp4")


class ScenarioTests(unittest.TestCase):
    def test_scenes_ia(self):
        rep = '{"scenes": [{"texte": "Accroche", "voix": "Voici une accroche."}, {"texte": "Fin"}]}'
        with mock.patch.object(llm, "ask", return_value=rep):
            scenes, warn = scenario.write("idée")
        self.assertEqual(scenes[1], {"texte": "Fin", "voix": "Fin"})
        self.assertIsNone(warn)

    def test_scenes_secours(self):
        with mock.patch.object(llm, "ask", side_effect=llm.LLMUnavailable("x")):
            scenes, warn = scenario.write("Un. Deux.")
        self.assertEqual([s["texte"] for s in scenes], ["Un", "Deux"])
        self.assertIsNotNone(warn)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg absent")
class MediaTests(unittest.TestCase):
    def test_musique(self):
        out = audio.make_music(2, __import__("pathlib").Path(os.environ["REELIO_DATA"]) / "m.wav")
        self.assertAlmostEqual(audio.duration(out), 2, delta=0.2)

    @unittest.skipUnless(audio.available_voice(), "aucune voix installée")
    def test_reel_voix_musique_dure_plus_que_le_minimum(self):
        out = reel.make_reel([{"texte": "Salut", "voix": "Bonjour et bienvenue sur Reelio, votre agent local."}],
                             os.path.join(os.environ["REELIO_DATA"], "v.mp4"), seconds_per_slide=1,
                             voice=True, music=True)
        self.assertGreater(audio.duration(out), 1.5)

    def test_visuels(self):
        for fmt, (w, h) in visuals.FORMATS.items():
            out = visuals.make_card("Titre de test", os.path.join(os.environ["REELIO_DATA"], f"{fmt}.png"), fmt, "sous-titre")
            from PIL import Image
            self.assertEqual(Image.open(out).size, (w, h))
        with self.assertRaises(ValueError):
            visuals.make_card("x", "x.png", "inconnu")


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.post = {"network": "x", "text": "Bonjour", "hashtags": "#web", "title": "", "reel_path": ""}

    def test_non_configure(self):
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(connectors.NotConfigured):
            connectors.publish(self.post)

    def test_x(self):
        calls = []
        def fake(method, url, headers=None, body=None, timeout=0):
            calls.append((method, url, headers, body))
            return {"data": {"id": "123"}}
        with mock.patch.dict(os.environ, {"X_ACCESS_TOKEN": "tok"}), mock.patch.object(connectors, "http", fake):
            self.assertEqual(connectors.publish(self.post), "123")
        self.assertEqual(calls[0][1], "https://api.x.com/2/tweets")
        self.assertEqual(calls[0][2]["Authorization"], "Bearer tok")
        self.assertIn("Bonjour", calls[0][3].decode())

    def test_facebook_texte(self):
        post = {**self.post, "network": "facebook"}
        env = {"FB_PAGE_ID": "42", "FB_PAGE_TOKEN": "t"}
        with mock.patch.dict(os.environ, env), mock.patch.object(connectors, "http", return_value={"id": "42_1"}) as h:
            self.assertEqual(connectors.publish(post), "42_1")
        self.assertIn("/42/feed", h.call_args[0][1])

    def test_instagram_exige_url_publique(self):
        vid = os.path.join(os.environ["REELIO_DATA"], "ig.mp4")
        open(vid, "wb").write(b"x")
        post = {**self.post, "network": "instagram", "reel_path": vid}
        env = {"IG_USER_ID": "1", "IG_TOKEN": "t"}
        with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(connectors.NotConfigured):
            connectors.publish(post)

    def test_tiktok_prive_par_defaut(self):
        vid = os.path.join(os.environ["REELIO_DATA"], "tt.mp4")
        open(vid, "wb").write(b"video")
        post = {**self.post, "network": "tiktok", "reel_path": vid}
        sent = []
        def fake(method, url, headers=None, body=None, timeout=0):
            sent.append((method, url, body))
            return {"data": {"upload_url": "https://up", "publish_id": "p1"}}
        with mock.patch.dict(os.environ, {"TIKTOK_ACCESS_TOKEN": "t"}), mock.patch.object(connectors, "http", fake):
            self.assertEqual(connectors.publish(post), "p1")
        self.assertIn("SELF_ONLY", sent[0][2].decode())


class SchedulingTests(unittest.TestCase):
    def test_programmation_et_echeance(self):
        pid = store.add_post("idée", "x", "Salut", ["#a"])
        ts = publisher.schedule(pid, "2030-01-01 10:00")
        self.assertNotIn(pid, [p["id"] for p in store.due_posts(ts - 1)])
        self.assertIn(pid, [p["id"] for p in store.due_posts(ts + 1)])
        with self.assertRaises(ValueError):
            publisher.schedule(pid, "demain")

    def test_hors_ligne_attend(self):
        pid = store.add_post("idée", "x", "Salut", [])
        ts = publisher.schedule(pid, "2030-01-01 10:00")
        with mock.patch.object(llm, "is_online", return_value=False):
            msgs = publisher.run_due(ts + 1)
        self.assertIn("Hors ligne", msgs[0])
        self.assertEqual(store.get_post(pid)["status"], "approuve")

    def test_en_ligne_sans_jeton_exporte(self):
        pid = store.add_post("idée", "x", "Salut", [])
        ts = publisher.schedule(pid, "2030-01-01 10:00")
        with mock.patch.object(llm, "is_online", return_value=True), mock.patch.dict(os.environ, {}, clear=True):
            publisher.run_due(ts + 1)
        self.assertEqual(store.get_post(pid)["status"], "exporte")

    def test_publication_reussie(self):
        pid = store.add_post("idée", "x", "Salut", [])
        with mock.patch.dict(os.environ, {"X_ACCESS_TOKEN": "t"}), \
             mock.patch.object(connectors, "http", return_value={"data": {"id": "9"}}):
            publisher.publish_post(pid)
        self.assertEqual((store.get_post(pid)["status"], store.get_post(pid)["external_id"]), ("publie", "9"))

    def test_echec_enregistre(self):
        pid = store.add_post("idée", "x", "Salut", [])
        with mock.patch.dict(os.environ, {"X_ACCESS_TOKEN": "t"}), \
             mock.patch.object(connectors, "http", side_effect=connectors.PublishError("401")):
            with self.assertRaises(connectors.PublishError):
                publisher.publish_post(pid)
        self.assertEqual(store.get_post(pid)["status"], "echec")


if __name__ == "__main__":
    unittest.main()
