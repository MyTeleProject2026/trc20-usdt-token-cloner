export type TronScanNetwork = 'mainnet' | 'nile' | 'shasta';

export declare function getTronScanTransactionUrl(
  network: unknown,
  transactionId: unknown,
): string | null;

export declare function getTronScanAddressUrl(
  network: unknown,
  address: unknown,
): string | null;

export declare function getTronScanNetworkLabel(network: unknown): string | null;
