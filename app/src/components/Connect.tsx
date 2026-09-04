import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useAccount, useConnect, useDisconnect, type Connector } from 'wagmi';
import { shortAddress } from '../lib/format';

const LAST_WALLET_KEY = 'dustsweep.lastWallet';
const INJECTED_ID = 'injected';
const WALLETCONNECT_ID = 'walletConnect';

/**
 * Some browsers throw on localStorage access rather than returning null:
 * Safari in Lockdown Mode, Chrome with third-party storage blocked, any
 * page in a sandboxed iframe. Losing the ordering hint is fine. Throwing
 * on the way to the connect button is not.
 */
function readLastWallet(): string | null {
  try {
    return window.localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return null;
  }
}

function rememberWallet(id: string) {
  try {
    window.localStorage.setItem(LAST_WALLET_KEY, id);
  } catch {
    /* see above -- nothing to recover, and nothing worth telling the user */
  }
}

/**
 * wagmi discovers every installed wallet over EIP-6963 and appends one
 * connector per wallet, keyed by rdns. Our own `injected()` entry is the
 * generic window.ethereum shim: no name, no icon, and it resolves to
 * whichever extension won the injection race.
 *
 * That race is the bug this file exists to fix -- Jake has Phantom, the
 * old `connectors[0]` went to MetaMask -- so once discovery has found
 * real wallets, drop the shim rather than offering it as a fourth,
 * unnamed choice that duplicates one of the other three. It stays as the
 * only option for a wallet that injects without announcing itself.
 *
 * WalletConnect is deliberately excluded from that discovery count. It is
 * configured unconditionally, so counting it as a "found wallet" would
 * make `announced` non-empty on every device and permanently hide the
 * legacy shim below, silently breaking the one case that fallback exists
 * for. It is appended last instead: after any real wallet, and on a phone
 * browser where nothing injects it is the only entry, which is exactly
 * the dead end it was added to fix.
 */
function walletsFrom(
  connectors: readonly Connector[],
  hasLegacyInjected: boolean,
): Connector[] {
  const wc = connectors.filter((c) => c.id === WALLETCONNECT_ID);
  const announced = connectors.filter(
    (c) => c.id !== INJECTED_ID && c.id !== WALLETCONNECT_ID,
  );
  if (announced.length > 0) return [...announced, ...wc];
  if (announced.length > 0) return announced;
  // The shim is in the config whether or not anything injected, which is
  // why the old code's "No wallet detected" branch could never be
  // reached -- connectors[0] always existed. Only offer it when there is
  // actually a window.ethereum for it to talk to.
  const shim = connectors.filter((c) => c.id === INJECTED_ID);
  return hasLegacyInjected ? [...shim, ...wc] : [...wc];
}

/** Last wallet used floats to the top. Everything else keeps its order. */
function orderWallets(
  connectors: readonly Connector[],
  hasLegacyInjected: boolean,
): Connector[] {
  const wallets = walletsFrom(connectors, hasLegacyInjected);
  const last = readLastWallet();
  if (!last) return wallets;
  const i = wallets.findIndex((c) => c.id === last);
  if (i <= 0) return wallets;
  return [wallets[i], ...wallets.slice(0, i), ...wallets.slice(i + 1)];
}

/**
 * Whether a plain window.ethereum exists. Wallets that predate EIP-6963
 * sometimes inject after first paint, so a one-shot read at mount would
 * strand those users on "No wallet detected". Wallets that DO announce
 * need none of this: wagmi appends their connectors on announcement and
 * re-renders on its own.
 */
function useLegacyInjected(): boolean {
  const [has, setHas] = useState(() => 'ethereum' in window);
  useEffect(() => {
    if (has) return;
    const recheck = () => setHas('ethereum' in window);
    window.addEventListener('ethereum#initialized', recheck, { once: true });
    const timer = setTimeout(recheck, 500);
    return () => {
      window.removeEventListener('ethereum#initialized', recheck);
      clearTimeout(timer);
    };
  }, [has]);
  return has;
}

export function ConnectButton({ full = false }: { full?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const hasLegacyInjected = useLegacyInjected();
  const wallets = useMemo(
    () => orderWallets(connectors, hasLegacyInjected),
    [connectors, hasLegacyInjected],
  );

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Escape and click-outside. Bound only while the picker is open so the
  // page carries no listeners in its resting state.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // The whole wrapper counts as inside, trigger included, so a second
    // click on the trigger closes via its own onClick instead of being
    // closed here and immediately reopened.
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // A picker left open behind a successful connect must not still be
  // sitting there when the user disconnects again.
  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);

  const choose = useCallback(
    (connector: Connector) => {
      rememberWallet(connector.id);
      setOpen(false);
      connect({ connector });
    },
    [connect],
  );

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

  if (wallets.length === 0) {
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

  const label = isPending ? 'Check your wallet' : 'Connect wallet';
  const buttonClass = `${shape} rounded-lg bg-orange font-semibold text-page transition hover:brightness-110 disabled:opacity-60`;

  // One wallet is not a choice. Connect straight to it, exactly as before.
  if (wallets.length === 1) {
    return (
      <button
        type="button"
        onClick={() => choose(wallets[0])}
        disabled={isPending}
        className={buttonClass}
      >
        {label}
      </button>
    );
  }

  return (
    <div ref={rootRef} className={full ? 'relative w-full' : 'relative'}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        className={buttonClass}
      >
        {label}
      </button>

      {open && (
        <WalletMenu
          wallets={wallets}
          full={full}
          onPick={choose}
          onLeave={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function WalletMenu({
  wallets,
  full,
  onPick,
  onLeave,
}: {
  wallets: Connector[];
  full: boolean;
  onPick: (connector: Connector) => void;
  /** Close without moving focus. Escape is handled by the parent, which
   *  does put focus back on the trigger; this one must not, or tabbing
   *  out of the picker would yank focus backwards. */
  onLeave: () => void;
}) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus the first option on open, so the picker is reachable from the
  // keyboard without tabbing through it.
  useEffect(() => {
    items.current[0]?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = items.current.findIndex((el) => el === document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = (at + step + wallets.length) % wallets.length;
    items.current[next]?.focus();
  };

  // In the header the picker hangs below a small right-aligned button. In
  // the card the button is the last thing above the fold, so it opens
  // upward instead of off the bottom of the screen.
  const place = full
    ? 'bottom-full left-0 mb-2 w-full'
    : 'top-full right-0 mt-2 min-w-[210px]';

  return (
    <div
      role="menu"
      aria-label="Choose a wallet"
      onKeyDown={onKeyDown}
      className={`${place} absolute z-20 rounded-lg border border-teal bg-raise p-1 shadow-lg shadow-black/40`}
    >
      {wallets.map((w, i) => (
        <button
          key={w.uid}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitem"
          onClick={() => onPick(w)}
          onBlur={(e) => {
            // Tabbing past the last option would otherwise leave the
            // picker open behind whatever the user moved on to.
            //
            // The relatedTarget null-check is load bearing. Safari does
            // not focus a button on mousedown, so a real click on another
            // option blurs this one with no relatedTarget at all -- close
            // on that and the menu unmounts between mousedown and click,
            // and the option can never be chosen with a mouse. Only a
            // blur that names where focus actually went counts.
            const to = e.relatedTarget;
            if (to && !e.currentTarget.parentElement?.contains(to)) onLeave();
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-cream transition-colors hover:bg-teal/40 focus:bg-teal/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-orange"
        >
          <WalletIcon connector={w} />
          <span className="min-w-0 grow truncate">{w.name}</span>
          {i === 0 && wallets.length > 1 && <LastUsed connector={w} />}
        </button>
      ))}
    </div>
  );
}

/** EIP-6963 hands us a data-URI icon. Wallets that skip it get a monogram. */
function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.icon) {
    return (
      <img
        src={connector.icon}
        alt=""
        width={20}
        height={20}
        className="size-5 shrink-0 rounded"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded bg-teal text-[10px] font-semibold text-cream"
    >
      {connector.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function LastUsed({ connector }: { connector: Connector }) {
  if (readLastWallet() !== connector.id) return null;
  return <span className="shrink-0 text-[10.5px] text-muted">Last used</span>;
}
