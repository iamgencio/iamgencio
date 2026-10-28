<?php
// Données de démonstration (œuvres fictives). Appelé par `php bin/migrate.php --seed`.
declare(strict_types=1);

use Nyota\Db;

$genres = ['action' => 'Action', 'aventure' => 'Aventure', 'fantasy' => 'Fantasy', 'sci-fi' => 'Science-fiction', 'mythologie' => 'Mythologie',
    'drame' => 'Drame', 'comedie' => 'Comédie', 'romance' => 'Romance', 'thriller' => 'Thriller', 'slice-of-life' => 'Tranche de vie',
    'sport' => 'Sport', 'horreur' => 'Horreur', 'historique' => 'Historique', 'afrofuturisme' => 'Afrofuturisme'];
foreach ($genres as $slug => $name) Db::run('INSERT IGNORE INTO genres (slug, name) VALUES (?,?)', [$slug, $name]);

$plans = [
    ['nyota-semaine', 'Nyota Semaine', 500, 7, 'Tous les chapitres premium|Sans publicité'],
    ['nyota-mois', 'Nyota Mois', 1500, 30, 'Tous les chapitres premium|Sans publicité|Sorties en avant-première'],
    ['nyota-annee', 'Nyota Année', 12000, 365, 'Tous les chapitres premium|Sans publicité|Sorties en avant-première|2 mois offerts'],
];
foreach ($plans as $p) Db::run('INSERT IGNORE INTO plans (code, name, price_xof, duration_days, perks) VALUES (?,?,?,?,?)', $p);

$users = [
    ['Admin Starlight', 'admin@starlight.network', 'admin'],
    ['Awa Créatrice', 'creator@starlight.network', 'creator'],
    ['Lecteur Démo', 'reader@starlight.network', 'reader'],
];
foreach ($users as [$n, $e, $r]) {
    Db::run('INSERT IGNORE INTO users (name, email, password_hash, role) VALUES (?,?,?,?)', [$n, $e, password_hash('Nyota2026!', PASSWORD_DEFAULT), $r]);
}
$creator = Db::one("SELECT id FROM users WHERE email = 'creator@starlight.network'")['id'];

// slug, titre, auteur, type, pays, accent, genres, synopsis, chapitres, vedette
$series = [
    ['gardiens-de-sankofa', 'Les Gardiens de Sankofa', 'Awa Diallo', 'bd_africaine', 'Sénégal', '#FFB627', ['aventure', 'mythologie', 'fantasy'],
        "Dakar, 2089. Quand les masques ancestraux se réveillent, trois adolescents héritent du pouvoir de protéger la mémoire du continent.", 12, 1],
    ['anansi-eclipse', 'Anansi : Éclipse', 'Kofi Mensah', 'bd_africaine', 'Ghana', '#FF6B35', ['action', 'mythologie'],
        "L'araignée Anansi a volé le soleil. Une chasseuse d'Accra doit retrouver ses fils avant la nuit éternelle.", 9, 1],
    ['lagos-2099', 'Lagos 2099', 'Chidi Okafor', 'bd_africaine', 'Nigeria', '#35D0FF', ['sci-fi', 'afrofuturisme', 'thriller'],
        "Dans une mégalopole flottante, une hackeuse découvre que la ville est pilotée par une IA qui rêve en yoruba.", 14, 1],
    ['reine-de-kemet', 'La Reine de Kemet', 'Nefertari Bakary', 'bd_africaine', "Côte d'Ivoire", '#C98BFF', ['historique', 'drame'],
        "Une jeune pharaonne reprend le trône d'un royaume assiégé, entre complots de cour et dieux capricieux.", 8, 0],
    ['maquis-de-minuit', 'Le Maquis de Minuit', 'Yasmine Traoré', 'bd_africaine', 'Mali', '#7BE495', ['comedie', 'slice-of-life'],
        "Chaque nuit, le plus petit maquis d'Abidjan sert des clients très inattendus : esprits, ministres et rappeurs.", 20, 0],
    ['kilimanjaro-blade', 'Kilimanjaro Blade', 'Jabari Mwangi', 'bd_africaine', 'Kenya', '#FFD66B', ['action', 'aventure'],
        "Un coureur de fond devient lame vivante d'une confrérie secrète perchée au sommet de la montagne.", 11, 0],
    ['etoile-du-ring', "L'Étoile du Ring", 'Moussa Keïta', 'bd_africaine', 'Guinée', '#FF5C8A', ['sport', 'drame'],
        "Du quartier de Matam au grand ring de Conakry : l'ascension d'un boxeur qui se bat pour sa famille.", 10, 0],
    ['lames-du-crepuscule', 'Lames du Crépuscule', 'Hana Sakurai', 'manga', 'Japon', '#8B5CFF', ['action', 'fantasy'],
        "Dans un empire où le soleil ne se couche plus, une épéiste porte la dernière lame capable de faire tomber la nuit.", 24, 1],
    ['academie-des-etoiles', 'Académie des Étoiles', 'Ren Tanabe', 'manga', 'Japon', '#FFB627', ['fantasy', 'comedie', 'slice-of-life'],
        "Chaque élève naît sous une constellation. Mira, elle, n'en a aucune — et c'est peut-être sa force.", 18, 0],
    ['pilote-du-neant', 'Pilote du Néant', 'Daichi Morimoto', 'manga', 'Japon', '#35D0FF', ['sci-fi', 'action'],
        "Un pilote de vaisseau sans mémoire traverse le vide pour retrouver l'équipage qu'il a trahi.", 30, 0],
    ['coeur-de-cendre', 'Cœur de Cendre', 'Yuna Hayashi', 'manga', 'Japon', '#FF6B35', ['romance', 'drame'],
        "Deux rivales d'un village de forgerons apprennent que leurs destins sont liés par le feu.", 15, 0],
    ['tour-des-ombres', 'La Tour des Ombres', 'Min-jun Seo', 'manhwa', 'Corée du Sud', '#C98BFF', ['action', 'fantasy', 'horreur'],
        "Au sommet d'une tour de 100 étages, chaque palier est un cauchemar. Jin n'a qu'une règle : ne jamais regarder en arrière.", 40, 1],
    ['heritiere-impériale', "L'Héritière Impériale", 'So-ra Kim', 'manhwa', 'Corée du Sud', '#FF5C8A', ['romance', 'historique'],
        "Réincarnée dans le corps d'une princesse condamnée, elle a trois mois pour changer l'histoire.", 22, 0],
    ['dernier-joueur', 'Le Dernier Joueur', 'Ha-neul Park', 'manhwa', 'Corée du Sud', '#7BE495', ['sci-fi', 'action'],
        "Le jeu a fermé ses serveurs. Un seul joueur est resté connecté — et le monde du jeu est devenu réel.", 35, 0],
];

foreach ($series as $i => [$slug, $title, $author, $type, $country, $accent, $gs, $syn, $nch, $feat]) {
    if (Db::one('SELECT 1 FROM series WHERE slug = ?', [$slug])) continue;
    $sid = Db::insert('INSERT INTO series (slug, title, author, synopsis, type, country, accent, publish_status, is_featured, views, creator_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)', [$slug, $title, $author, $syn, $type, $country, $accent, 'published', $feat, random_int(2000, 90000) - $i * 100,
        $type === 'bd_africaine' ? $creator : null]);
    foreach ($gs as $g) Db::run('INSERT IGNORE INTO series_genres (series_id, genre_id) SELECT ?, id FROM genres WHERE slug = ?', [$sid, $g]);
    $count = min($nch, 8); // chapitres de démo (8 max par série)
    for ($c = 1; $c <= $count; $c++) {
        $premium = $c > 3 ? 1 : 0;
        $cid = Db::insert('INSERT INTO chapters (series_id, number, title, is_premium, published_at) VALUES (?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
            [$sid, $c, "Chapitre $c", $premium, ($count - $c) * 7]);
        for ($p = 1; $p <= 8; $p++) {
            Db::run('INSERT INTO pages (chapter_id, position, image_url) VALUES (?,?,?)', [$cid, $p, "placeholder:$slug:$c:$p"]);
        }
    }
}
echo "Données de démonstration insérées (mot de passe des comptes : Nyota2026!).\n";
