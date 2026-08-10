// Accumu v2 — 관리자 활동 캘린더 팝업 (ADR 0013)
//
// [학생 캘린더와 같은 뼈대, 다른 데이터원]
//   학생: participations + programs 를 날짜축으로 (내가 참여하는 활동)
//   관리자: 내가 올린 programs 를 날짜축으로 (내가 운영하는 활동)
//   두 화면 모두 **새 테이블도 새 권한도 만들지 않는다** — 이미 읽을 수 있는 것을 달력으로 다시 그린다.
//
// [원칙 6 — 관리자 동작이 0개 늘었다] 여기서 할 수 있는 일이 없다. 등록·수정·내리기·스캔 진입이 전부
//   없고 읽기만 한다. 관리자 홈의 "오늘 진행 프로그램"을 한 달 단위로 본 것이 이 화면의 전부다.
//   >>> 이 팝업에 액션 버튼(스캔 이동·내리기 등)을 붙이지 말 것. 붙이는 순간 4번째 기능이 된다.
//
// [원칙 1 — 게임화 금지] 운영 건수·참여율·달성률을 세지 않는다. 점은 계열 색이고 배지는
//   "예정 / 오늘 / 종료" 3종 사실 표시다. 숫자를 집계하는 규칙이 이 파일에 없다.
import { useEffect, useMemo, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { fetchAdminPrograms } from '../../lib/programService';
import { catOf } from '../../lib/taxonomy';
import { fmtDate, todayISO } from '../../lib/date';
import '../../styles/Notifications.css';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const pad2 = (n) => String(n).padStart(2, '0');

/** 프로그램 1건 -> 달력 상태. 날짜만 본다(게시 여부는 별도 표시 — 아래 unpub). */
function kindOf(iso, today) {
  if (iso < today) return 'done';
  if (iso === today) return 'ing';
  return 'up';
}
const KIND_LABEL = { done: '종료', ing: '오늘 진행', up: '진행 예정' };

export default function AdminCalendarPopup({ adminId, onClose }) {
  const today = todayISO();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() }; // m: 0-11
  });
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!adminId) return undefined;
    let alive = true;
    fetchAdminPrograms(adminId)
      .then((data) => alive && setRows(data))
      .catch((err) => {
        console.error('[AdminCalendarPopup] 프로그램 조회 실패:', err);
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [adminId]);

  /** [기간제 — 20260810] session_dates 가 있으면 시작일 하루가 아니라 실제 진행일마다 꽂는다.
   *  아래 kindOf(iso, today)는 날짜 하나를 인자로 받으므로 날짜별로 종료/오늘 진행/예정이 정확히 갈린다. */
  const byDate = useMemo(() => {
    const map = new Map();
    (rows ?? []).forEach((p) => {
      const dates = p.session_dates?.length ? p.session_dates : [p.date].filter(Boolean);
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
      <div key={iso} className={cls} title={list.length ? `${list.length}건의 프로그램` : undefined}>
        <span className="dn">{d}</span>
        <div className="dots">
          {list.slice(0, 3).map((p) => (
            <i key={p.id} style={{ background: catOf(p.category).color }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="admincal-title" closeAbove>
      <div className="mbody">
        <div className="calhead">
          <button type="button" onClick={() => move(-1)} aria-label="이전 달">
            <Icon name="ic-chevL" size={20} />
          </button>
          <div className="caltitle" id="admincal-title">
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
              이 달에는 내가 올린 프로그램이 없어요.
              <br />
              양옆 화살표로 다른 달을 확인해 보세요.
            </div>
          )}

          {monthEvents.map(({ iso, p }) => {
            const cat = catOf(p.category);
            const kind = kindOf(iso, today);
            return (
              <div key={p.id} className="cev">
                <div className="cevic" style={{ background: cat.soft }}>
                  <Icon name={cat.icon} size={18} color={cat.color} />
                </div>
                <div className="cevinfo">
                  <h5>{p.title}</h5>
                  <div className="m">
                    {fmtDate(iso)}
                    {p.time ? ` · ${p.time}` : ''}
                    {/* 게시 상태는 사실이라 감추지 않는다. 다만 색을 주지 않아 배지와 경쟁하지 않게 한다. */}
                    {!p.is_published ? ' · 미게시' : ''}
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
