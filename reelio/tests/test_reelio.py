import os
import shutil
import tempfile
import unittest
from unittest import mock

os.environ["REELIO_DATA"] = tempfile.mkdtemp()

from reelio import copywriter, llm, publisher, reel, store  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
