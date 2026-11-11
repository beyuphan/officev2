"""Ready-made patterns for finding sensitive data in text (used by redaction)."""
from __future__ import annotations

import re
from typing import Callable

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_TCKN = re.compile(r"(?<!\d)[1-9]\d{10}(?!\d)")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b")
_PHONE = re.compile(r"(?<![\w])(?:\+|00)?(?:90[ -]?)?\(?0?5\d{2}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)|(?<![\w])\+\d{1,3}(?:[ -]?\d{2,4}){2,4}(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")


def _tckn_ok(s: str) -> bool:
    d = [int(c) for c in s]
    if len(d) != 11 or d[0] == 0:
        return False
    if (sum(d[0:9:2]) * 7 - sum(d[1:8:2])) % 10 != d[9]:
        return False
    return sum(d[:10]) % 10 == d[10]


def _luhn_ok(s: str) -> bool:
    digits = [int(c) for c in s if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, n in enumerate(reversed(digits)):
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _iban_ok(s: str) -> bool:
    raw = s.replace(" ", "")
    if not 15 <= len(raw) <= 34:
        return False
    moved = raw[4:] + raw[:4]
    num = "".join(str(int(c, 36)) for c in moved)
    return int(num) % 97 == 1


Matcher = Callable[[str], list[str]]


def _checked(rx: re.Pattern, ok: Callable[[str], bool]) -> Matcher:
    return lambda text: [m.group(0) for m in rx.finditer(text) if ok(m.group(0))]


def _plain(rx: re.Pattern) -> Matcher:
    return lambda text: [m.group(0) for m in rx.finditer(text)]


BUILTIN: dict[str, Matcher] = {
    "email": _plain(_EMAIL),
    "tckn": _checked(_TCKN, _tckn_ok),  # Turkish national ID: the checksum keeps random 11-digit numbers out
    "iban": _checked(_IBAN, _iban_ok),
    "phone": _plain(_PHONE),
    "card": _checked(_CARD, _luhn_ok),
}


def compile_matchers(patterns: list[str], regex: str | None) -> list[Matcher]:
    out: list[Matcher] = []
    for name in patterns:
        if name not in BUILTIN:
            raise ValueError(f"unknown pattern '{name}'")
        out.append(BUILTIN[name])
    if regex:
        try:
            rx = re.compile(regex)
        except re.error as e:
            raise ValueError(f"the pattern is not valid: {e}")
        out.append(lambda text, rx=rx: [m.group(0) for m in rx.finditer(text) if m.group(0).strip()])
    return out


def find_all(matchers: list[Matcher], text: str) -> set[str]:
    found: set[str] = set()
    for m in matchers:
        found.update(x.strip() for x in m(text) if x.strip())
    return found
