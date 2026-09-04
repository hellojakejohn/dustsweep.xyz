import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { shortAddress } from '../lib/format';

export function ConnectButton({ full = false }: { full?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const shape = full ? 'h-[52px] w-full text-[14px]' : 'h-8 px-3 text-[12px]';

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        className={`${shape} num group rounded-lg border border-teal text-muted transition-colors hover:border-orange hover:text-cream`}
      >
        <span className="group-hover:hidden">{shortAddress(address)}</span>
        <span className="hidden font-sans group-hover:inline">Disconnect</span>
      </button>
    );
  }

  const injected = connectors[0];

  if (!injected) {
    return (
      <a
        href="https://ethereum.org/en/wallets/find-wallet/"
        target="_blank"
        rel="noreferrer"
        className={`${shape} inline-flex items-center justify-center rounded-lg border border-teal text-muted transition-colors hover:text-cream`}
      >
        No wallet detected
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => connect({ connector: injected })}
      disabled={isPending}
      className={`${shape} rounded-lg bg-orange font-semibold text-page transition hover:brightness-110 disabled:opacity-60`}
    >
      {isPending ? 'Check your wallet' : 'Connect wallet'}
    </button>
  );
}
