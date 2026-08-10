// Accumu v2 — 활동 캘린더 팝업 (docs/specs/notifications-calendar.md)
//
// [새 테이블도, 새 쿼리도 없다] 캘린더는 participations + programs 를 날짜축으로 다시 그린 것일 뿐이다.
//   participationService.fetchMyParticipationsWithProgram() 이 이미 status/entry_at/exit_at/program(date,
//   time, title, category)을 준다. 캘린더 전용 저장소를 만들면 같은 사실이 두 곳에 생긴다.
//
// [기준일은 언제나 실제 오늘] 프로토타입은 TODAY_ISO='2026-07-02' 와 calYear/calMonth 를 2026년 7월로
//   하드코딩했다(1161·1169줄). CLAUDE.md 9장이 금지한 형태라 여기서는 date.js 의 todayISO() 를 쓰고
//   기본 표시 달도 오늘의 달이다.
//
// [원칙 1 — 게임화 금지] 연속 참여일·달성률·월간 목표를 그리지 않는다. 날짜의 점은 계열 색이고,
//   배지는 대기중/예정/참석 중/완료 4종 사실 표시다(ADR 0016 — waitlisted 추가). 숫자를 세는 규칙이 이 파일에 없다.
import { useEffect, useMemo, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { fetchMyParticipationsWithProgram } from '../../lib/participationService';
import { catOf } from '../../lib/taxonomy';
import { fmtDate, todayISO } from '../../lib/date';
import '../../styles/Notifications.css';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const pad2 = (n) => String(n).padStart(2, '0');

/** 참여 1건 -> 캘린더 상태. waitlisted(ADR 0016)가 최우선 — 자리가 확정되지 않았으므로 entry_at/exit_at이
 *  둘 다 null인 게 당연하고, 그 상태를 "참여 예정"으로 보여주면 자리가 있다는 거짓 정보가 된다.
 *  그 외엔 기존 그대로: exit_at 있으면 완료, entry_at만 있으면 참석 중, 둘 다 없으면 예정. */
function kindOf(p) {
  if (p.status === 'waitlisted') return 'wait';
  if (p.exit_at) return 'done';
  if (p.entry_at) return 'ing';
  return 'up';
}
const KIND_LABEL = { wait: '대기중', done: '참여 완료', ing: '참석 중', up: '참여 예정' };

export default function CalendarPopup({ onClose }) {
  const today = todayISO();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() }; // m: 0-11
  });
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchMyParticipationsWithProgram()
      .then((data) => alive && setRows(data))
      .catch((err) => {
        console.error('[CalendarPopup] 참여 조회 실패:', err);
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** ISO 날짜 -> 그 날의 활동들. 게시중단된 프로그램은 program 이 null 이라 건너뛴다(ADR 0005 결정 7-4).
   *  [기간제 — 20260810] program.session_dates 가 있으면 시작일 하루가 아니라 그 배열 전체(실제 진행일마다)에
   *  꽂는다. 같은 참여가 여러 날짜에 나타나는 게 정상이다 — "이 활동이 그날에도 있었다"는 사실 그대로다. */
  const byDate = useMemo(() => {
    const map = new Map();
    (rows ?? []).forEach((p) => {
      const dates = p.program?.session_dates?.length ? p.program.session_dates : [p.program?.date].filter(Boolean);
      dates.forEach((iso) => {
        if (!map.has(iso)) map.set(iso, []);
        map.get(iso).push(p);
      });
    });
    return map;
  }, [rows]);

  const { y, m } = cursor;
  const monthPrefix = `${y}-${pad2(m + 1)}`;
  const startDow = new Date(y, m, 1).getDay();
  const dayCount = new Date(y, m + 1, 0).getDate();

  /** 이 달의 활동을 날짜순으로 편 목록 */
  const monthEvents = useMemo(() => {
    const out = [];
    byDate.forEach((list, iso) => {
      if (iso.startsWith(monthPrefix)) list.forEach((p) => out.push({ iso, p }));
    });
    return out.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  }, [byDate, monthPrefix]);

  function move(delta) {
    setCursor(({ y: cy, m: cm }) => {
      const next = new Date(cy, cm + delta, 1);
      return { y: next.getFullYear(), m: next.getMonth() };
    });
  }

  const cells = [];
  for (let i = 0; i < startDow; i += 1) cells.push(<div key={`e${i}`} className="cday empty" />);
  for (let d = 1; d <= dayCount; d += 1) {
    const iso = `${monthPrefix}-${pad2(d)}`;
    const list = byDate.get(iso) ?? [];
    const cls = ['cday', list.length ? 'has' : '', iso === today ? 'today' : ''].filter(Boolean).join(' ');
    cells.push(
      <div key={iso} className={cls} title={list.length ? `${list.length}건의 활동` : undefined}>
        <span className="dn">{d}</span>
        <div className="dots">
          {list.slice(0, 3).map((p) => (
            <i key={p.id} style={{ background: catOf(p.program?.category).color }} />
          ))}
        </div>
      </div>
    );
  }

  // closeAbove — 기본 위치(카드 안 우상단)는 "다음 달" 화살표와 정확히 겹친다.
  return (
    <Modal onClose={onClose} labelledBy="cal-title" closeAbove>
      <div className="mbody">
        <div className="calhead">
          <button type="button" onClick={() => move(-1)} aria-label="이전 달">
            <Icon name="ic-chevL" size={20} />
          </button>
          <div className="caltitle" id="cal-title">
            {y}년 {m + 1}월
          </div>
          <button type="button" onClick={() => move(1)} aria-label="다음 달">
            <Icon name="ic-chevR" size={20} />
          </button>
        </div>

        <div className="cal-today">오늘 · {fmtDate(today)}</div>

        <div className="calgrid">
          {DOW.map((d, i) => (
            <div key={d} className={i === 0 ? 'dow sun' : 'dow'}>
              {d}
            </div>
          ))}
          {cells}
        </div>

        <div className="callist">
          {rows === null && <div className="empty">불러오는 중…</div>}

          {rows !== null && monthEvents.length === 0 && (
            <div className="empty" style={{ padding: '22px 20px' }}>
              이 달에는 나의 활동 기록이 없어요.
              <br />
              양옆 화살표로 다른 달을 확인해 보세요.
            </div>
          )}

          {monthEvents.map(({ iso, p }) => {
            const cat = catOf(p.program?.category);
            const kind = kindOf(p);
            return (
              <div key={p.id} className="cev">
                <div className="cevic" style={{ background: cat.soft }}>
                  <Icon name={cat.icon} size={18} color={cat.color} />
                </div>
                <div className="cevinfo">
                  <h5>{p.program?.title ?? '게시가 중단된 프로그램'}</h5>
                  <div className="m">
                    {fmtDate(iso)}
                    {p.program?.time ? ` · ${p.program.time}` : ''}
                  </div>
                </div>
                <span className={`cb ${kind}`}>{KIND_LABEL[kind]}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
