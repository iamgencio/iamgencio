"""Ligne de commande : reelio generer / liste / exporter / serveur."""
import argparse
import sys
import time

from . import config, copywriter, pipeline, publisher, store, visuals


def cmd_generer(args) -> int:
    reseaux = args.reseaux.split(",") if args.reseaux else None
    ids, warnings = pipeline.create(args.idee, reseaux, args.reel or args.voix or args.musique,
                                    args.voix, args.musique)
    for w in warnings:
        print(f"⚠ {w}", file=sys.stderr)
    for pid in ids:
        p = store.get_post(pid)
        print(f"── {copywriter.NETWORKS[p['network']]['label']} (#{pid}) ──\n"
              f"{p['title'] + chr(10) if p['title'] else ''}{p['text']}\n\n{p['hashtags']}\n")
    if ids and store.get_post(ids[0])["reel_path"]:
        print(f"🎬 Reel : {store.get_post(ids[0])['reel_path']}")
    return 0


def cmd_visuel(args) -> int:
    out = visuals.make_card(args.titre, config.DATA_DIR / "visuels" / f"visuel-{int(time.time())}-{args.format}.png",
                            args.format, args.sous_titre)
    print(f"🖼  {out}")
    return 0


def cmd_planifier(args) -> int:
    publisher.schedule(args.id, args.quand)
    print(f"#{args.id} programmée pour le {args.quand}. Lancez « reelio agent » pour la publier à l'heure.")
    return 0


def cmd_publier(args) -> int:
    print(publisher.publish_post(args.id))
    return 0


def cmd_agent(args) -> int:
    print("Agent actif : vérifie les publications programmées chaque minute (Ctrl+C pour arrêter).")
    try:
        while True:
            for line in publisher.run_due():
                print(line)
            time.sleep(60)
    except KeyboardInterrupt:
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
    g.add_argument("--reel", action="store_true", help="créer aussi un reel vidéo (scénario écrit par l'IA)")
    g.add_argument("--voix", action="store_true", help="reel avec voix off (synthèse vocale locale)")
    g.add_argument("--musique", action="store_true", help="reel avec musique d'ambiance")
    g.set_defaults(func=cmd_generer)
    v = sub.add_parser("visuel", help="Créer un visuel de marque (carte ou miniature)")
    v.add_argument("titre")
    v.add_argument("--sous-titre", default="")
    v.add_argument("--format", choices=list(visuals.FORMATS), default="carre")
    v.set_defaults(func=cmd_visuel)
    pl = sub.add_parser("planifier", help="Programmer une publication")
    pl.add_argument("id", type=int)
    pl.add_argument("quand", help="AAAA-MM-JJ HH:MM (heure locale)")
    pl.set_defaults(func=cmd_planifier)
    pu = sub.add_parser("publier", help="Publier maintenant via l'API du réseau (sinon exporter)")
    pu.add_argument("id", type=int)
    pu.set_defaults(func=cmd_publier)
    ag = sub.add_parser("agent", help="Publier automatiquement les publications programmées")
    ag.set_defaults(func=cmd_agent)
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
