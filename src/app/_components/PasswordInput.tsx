'use client';

import { useId, useState } from 'react';

/**
 * A password box with a show/hide eye — used for every password field in the
 * app, so the behaviour is identical wherever someone types one.
 *
 * Why it matters more than it looks: a homeowner reading a password an admin
 * gave them over the phone, or anyone typing a long passphrase on a phone
 * keyboard, cannot tell a typo from a wrong password without seeing it. The
 * alternative is people choosing short passwords they can type blind.
 *
 * Details that are easy to get wrong and are handled here:
 *  - The toggle is a real button with type="button", so pressing Enter in the
 *    field submits the form rather than flipping visibility.
 *  - It is announced to screen readers (aria-pressed + a label that changes),
 *    and reachable by keyboard, rather than being a decorative icon.
 *  - autoComplete is passed straight through, so password managers still offer
 *    to fill and to save.
 *  - While revealed the input is type="text", which browsers autocapitalise and
 *    spellcheck by default — both are turned off, or a phone would quietly
 *    capitalise the first letter of a password.
 *  - Visibility is component state only: it never persists, so a revealed
 *    password does not survive a reload or a second visit.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  defaultValue,
  autoComplete = 'current-password',
  required = false,
  minLength,
  placeholder,
  hint,
  disabled = false,
  autoFocus = false,
  name,
  describedBy,
  invalid = false,
}: {
  label: string;
  /** Controlled use: pass both. Omit both for a FormData-read field. */
  value?: string;
  onChange?: (value: string) => void;
  defaultValue?: string;
  autoComplete?: 'current-password' | 'new-password' | 'off';
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  /** Small print under the field — rules, or where the password came from. */
  hint?: React.ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  name?: string;
  /**
   * Id of a message that explains a failure — the sign-in error, say. Points the
   * field at it so a screen reader hears the reason with the field rather than
   * only as a colour somewhere above (Sign-in Screens §8).
   */
  describedBy?: string;
  invalid?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();

  return (
    <div className="field">
      <label htmlFor={id}>
        <span>{label}</span>
      </label>
      <div className="password-wrap">
        <input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required={required}
          minLength={minLength}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          {...(onChange
            ? { value: value ?? '', onChange: (e) => onChange(e.target.value) }
            : { defaultValue })}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          aria-label={shown ? 'Hide password' : 'Show password'}
          title={shown ? 'Hide password' : 'Show password'}
          disabled={disabled}
        >
          <EyeIcon crossed={shown} />
        </button>
      </div>
      {hint && <small className="dim">{hint}</small>}
    </div>
  );
}

/** An eye, struck through while the password is visible. */
function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.8 12S5.4 5.5 12 5.5 22.2 12 22.2 12 18.6 18.5 12 18.5 1.8 12 1.8 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      {crossed && <path d="M4 20 20 4" />}
    </svg>
  );
}
