import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { lang, t } from './i18n.js';
import { place } from './Select.jsx';
import { Icon } from './ui.jsx';

// A date field drawn by the app: the browser's own date picker follows the browser's language,
// which a page cannot change, so it showed English on some phones. A hidden input holds the
// value that is sent, as YYYY-MM-DD; the calendar here only shows it and sets it.

const parse = s => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const iso = date => date.toLocaleDateString('sv'); // YYYY-MM-DD in local time
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
// the same day in another month, or that month's last day when it is shorter
const addMonths = (s, n) => {
  const d = parse(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return iso(d);
};

const longDate = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthTitle = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' });
// the week starts on Monday: 5 January 2026 was one
const weekdays = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(lang, { weekday: 'narrow' }).format(new Date(2026, 0, 5 + i)));
const weekdayNames = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(new Date(2026, 0, 5 + i)));

// Six weeks from the Monday on or before the 1st, so the calendar keeps the same height.
function monthDays(s) {
  const first = parse(s);
  first.setDate(1);
  const start = iso(first);
  return [...Array(42)].map((_, i) => addDays(start, i - (first.getDay() + 6) % 7));
}

export function DateInput({ name, defaultValue, 'aria-label': ariaLabel }) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(defaultValue); // the day the keyboard is on
  const button = useRef(null);
  const pop = useRef(null);
  const uid = useId();
  const today = iso(new Date());

  const close = () => setOpen(false);
  // as tall as the whole calendar, borders included, so that no scrollbar cuts its corners
  const fit = () => {
    const el = pop.current;
    el.style.maxHeight = 'none';
    const tall = Math.ceil(el.getBoundingClientRect().height);
    place(button.current, el, tall, tall);
  };
  const openCalendar = () => {
    setCursor(value);
    setOpen(true);
  };
  const choose = day => {
    setValue(day);
    close();
    button.current.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const el = pop.current;
    el.showPopover();
    fit();
    el.focus();
    const onOutside = e => !el.contains(e.target) && !button.current.contains(e.target) && close();
    const onScroll = e => e.target !== el && close();
    document.addEventListener('pointerdown', onOutside, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', close);
    return () => {
      try {
        el.hidePopover();
      } catch {} // already gone with its window
      document.removeEventListener('pointerdown', onOutside, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', close);
    };
  }, [open]);

  // a change of month can make the calendar taller or shorter than the room left
  useEffect(() => {
    if (open) fit();
  }, [open, cursor.slice(0, 7)]);

  function onKey(e) {
    const weekday = (parse(cursor).getDay() + 6) % 7;
    const moves = {
      ArrowRight: () => addDays(cursor, 1),
      ArrowLeft: () => addDays(cursor, -1),
      ArrowDown: () => addDays(cursor, 7),
      ArrowUp: () => addDays(cursor, -7),
      Home: () => addDays(cursor, -weekday),
      End: () => addDays(cursor, 6 - weekday),
      PageDown: () => addMonths(cursor, e.shiftKey ? 12 : 1),
      PageUp: () => addMonths(cursor, e.shiftKey ? -12 : -1),
    };
    if (e.key in moves) {
      e.preventDefault();
      setCursor(moves[e.key]());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(cursor);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Escape closes the calendar only, not the window around it
      e.preventDefault();
      e.stopPropagation();
      close();
      button.current.focus();
    }
  }

  const month = cursor.slice(0, 7);
  const days = monthDays(cursor);
  // the month buttons keep the focus on the calendar, for the keyboard
  const keepFocus = e => e.preventDefault();

  return (
    // the button comes first, so a <label> around it names it and opens the calendar
    <span className="pick">
      <button
        type="button"
        className="pick-btn"
        ref={button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openCalendar())}
        onKeyDown={e => {
          if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
          e.preventDefault();
          openCalendar();
        }}
      >
        <span>{longDate.format(parse(value))}</span>
      </button>
      <input type="hidden" name={name} value={value} />
      <div className="pick-list cal" ref={pop} role="dialog" aria-label={ariaLabel} tabIndex={-1} popover="manual" onKeyDown={onKey}>
        {open && (
          <>
            <div className="cal-head">
              <button type="button" className="icon" aria-label={t('prevMonth')} onPointerDown={keepFocus} onClick={() => setCursor(addMonths(cursor, -1))}>
                <Icon name="chevron-left" />
              </button>
              <span aria-live="polite">{monthTitle.format(parse(cursor))}</span>
              <button type="button" className="icon" aria-label={t('nextMonth')} onPointerDown={keepFocus} onClick={() => setCursor(addMonths(cursor, 1))}>
                <Icon name="chevron-right" />
              </button>
            </div>
            <div className="cal-grid" role="grid" aria-activedescendant={`${uid}-${cursor}`}>
              {weekdays.map((d, i) => <abbr key={i} title={weekdayNames[i]} role="columnheader">{d}</abbr>)}
              {days.map(day => (
                <div
                  key={day}
                  id={`${uid}-${day}`}
                  role="gridcell"
                  aria-selected={day === value}
                  aria-label={longDate.format(parse(day))}
                  className={[day === cursor && 'active', day.slice(0, 7) !== month && 'out', day === today && 'today'].filter(Boolean).join(' ')}
                  onClick={() => choose(day)}
                >
                  {parse(day).getDate()}
                </div>
              ))}
            </div>
            <button type="button" className="link" onPointerDown={keepFocus} onClick={() => choose(today)}>{t('today')}</button>
          </>
        )}
      </div>
    </span>
  );
}
