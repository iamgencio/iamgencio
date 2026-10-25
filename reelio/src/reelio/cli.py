"""Ligne de commande : reelio generer / liste / exporter / serveur."""
import argparse
import sys
import time

from . import config, copywriter, publisher, reel, store


def cmd_generer(args) -> int:
    reseaux = args.reseaux.split(",") if args.reseaux else None
    posts, warning = copywriter.generate(args.idee, reseaux)
    if warning:
        print(f"⚠ {warning}\n", file=sys.stderr)
    reel_path = ""
    if args.reel:
        reel_path = reel.make_reel(reel.script_from_idea(args.idee),
                                   config.REELS_DIR / f"reel-{int(time.time())}.mp4")
        print(f"🎬 Reel : {reel_path}\n")
    for net, p in posts.items():
        pid = store.add_post(args.idee, net, p.text, p.hashtags, p.title, reel_path)
        print(f"── {copywriter.NETWORKS[net]['label']} (#{pid}) ──\n{p.title + chr(10) if p.title else ''}"
              f"{p.full_text()}\n")
    return 0


def cmd_liste(args) -> int:
    for p in store.list_posts(args.statut):
        print(f"#{p['id']:<4} {p['network']:<10} {p['status']:<10} {p['text'][:60]!r}")
    return 0


def cmd_exporter(args) -> int:
    print(f"Exporté dans : {publisher.export_post(args.id)}")
    return 0


def cmd_serveur(args) -> int:
    from . import web
    web.run(args.port)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="reelio", description="Agent IA local de community management")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generer", help="Générer textes et hashtags (et un reel) à partir d'une idée")
    g.add_argument("idee")
    g.add_argument("--reseaux", help="ex. facebook,instagram,x,youtube,tiktok (défaut : tous)")
    g.add_argument("--reel", action="store_true", help="créer aussi un reel vidéo")
    g.set_defaults(func=cmd_generer)
    l = sub.add_parser("liste", help="Lister les publications")
    l.add_argument("--statut", choices=store.STATUSES)
    l.set_defaults(func=cmd_liste)
    e = sub.add_parser("exporter", help="Exporter une publication prête à publier")
    e.add_argument("id", type=int)
    e.set_defaults(func=cmd_exporter)
    s = sub.add_parser("serveur", help="Lancer l'interface web locale")
    s.add_argument("--port", type=int, default=8765)
    s.set_defaults(func=cmd_serveur)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
