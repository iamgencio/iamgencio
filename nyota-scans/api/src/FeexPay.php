<?php
declare(strict_types=1);

namespace Nyota;

/**
 * Client FeexPay (Mobile Money Afrique de l'Ouest : MTN, Moov, Orange, Wave, Celtiis...).
 * Mode "mock" : simule un paiement réussi sans appel réseau (développement).
 * Mode "live" : appelle l'API FeexPay. Vérifiez les chemins/champs avec https://docs.feexpay.me
 * avant la mise en production — ils sont isolés ici pour être ajustés en un seul endroit.
 */
final class FeexPay
{
    public const NETWORKS = [
        'mtn' => 'MTN Mobile Money',
        'moov' => 'Moov Money',
        'orange' => 'Orange Money',
        'wave' => 'Wave',
        'celtiis' => 'Celtiis Cash',
    ];

    public static function mode(): string { return Config::get('FEEXPAY_MODE', 'mock'); }

    /** @return array{provider_ref:string,status:string} */
    public static function requestToPay(string $reference, int $amount, string $network, string $phone, array $user, string $description): array
    {
        if (self::mode() !== 'live') {
            return ['provider_ref' => 'mock_' . $reference, 'status' => 'success'];
        }
        $res = self::call('POST', '/api/transactions/requesttopay/' . rawurlencode($network), [
            'phoneNumber' => $phone,
            'amount' => $amount,
            'reseau' => strtoupper($network),
            'token' => Config::get('FEEXPAY_TOKEN'),
            'shop' => Config::get('FEEXPAY_SHOP_ID'),
            'first_name' => $user['name'],
            'last_name' => 'Nyota',
            'email' => $user['email'],
            'description' => $description,
            'callback_info' => $reference,
        ]);
        return ['provider_ref' => (string) ($res['reference'] ?? ''), 'status' => 'pending'];
    }

    public static function status(string $providerRef): string
    {
        if (self::mode() !== 'live') return 'success';
        $res = self::call('GET', '/api/transactions/getrequesttopay/integration/' . rawurlencode($providerRef));
        return match (strtoupper((string) ($res['status'] ?? ''))) {
            'SUCCESSFUL', 'SUCCESS' => 'success',
            'FAILED', 'CANCELLED' => 'failed',
            default => 'pending',
        };
    }

    private static function call(string $method, string $path, ?array $body = null): array
    {
        $ch = curl_init(rtrim(Config::get('FEEXPAY_BASE_URL', 'https://api.feexpay.me'), '/') . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . Config::get('FEEXPAY_TOKEN'),
            ],
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if ($code >= 400 || !is_array($data)) {
            throw new HttpError(502, 'Le service de paiement est indisponible, réessayez.');
        }
        return $data;
    }
}
