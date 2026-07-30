// Accumu v2 — 학생 QR 목록/표시 모달 (docs/specs/qr-dual-auth.md A·B절, 확정 F-1)
// Accumu_prototype.html openQrList()(1003줄) + showScan()(1025줄)의 구조·카피를 재현한다.
//
// [프로토타입과 의도적으로 다른 곳 — 이게 v2의 본체다]
//   1. "5초 후 자동 처리" 카운트다운(1039줄)을 삭제했다. 스캐너가 없던 시절의 가짜 시뮬레이션이고,
//      그대로 옮기면 그 자체가 절대 원칙 5의 "단순화"다. 같은 자리에 남은 유효시간(mm:ss)을 표시한다.
//   2. 상태 전이는 학생이 만들지 않는다. 관리자가 스캔해야 서버가 전이시키고, 학생 화면은 10초 폴링으로
//      그 결과를 따라간다 (participations 에 update 정책이 학생·관리자 모두 0개 — ADR 0005 결정 2).
//   3. 프로토타입 1054줄의 축하 이모지 토스트("참여 완료! +300P 지급")를 옮기지 않았다.
//      컨페티·사운드·숫자 카운트업·축하 이모지 금지 (원칙 1). 담백한 체크 아이콘 + 문구까지만.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import Icon from '../Icon';
import Modal from '../Modal';
import { useAuth } from '../../context/AuthContext';
import { catOf } from '../../lib/taxonomy';
import { fmtDate } from '../../lib/date';
import {
  buildQrPayload,
  fetchMyParticipationsWithProgram,
  fetchParticipationStatuses,
  issueQr,
  issueRejectText,
} from '../../lib/participationService';
import '../../styles/Qr.css';

const POLL_MS = 10_000; // 스펙 요구사항: 10초 간격 폴링 (realtime 구독 금지)

/** 참여 상태 -> 목록 보조 문구 (프로토타입 1013줄 카피) */
const STATUS_LABEL = { applied: '입장 대기', entered: '참석 중 (퇴장 전)' };

/**
 * 게시중단된 프로그램의 참여 건은 학생이 programs 행을 읽을 수 없다 (ADR 0005 결정 7-4 "알려진 틈").
 * program_id 만 있고 프로그램 정보가 없는 경우를 오류가 아니라 정상 경로로 다룬다.
 */
function programView(program) {
  if (program) {
    const cat = catOf(program.category);
    return {
      title: program.title,
      icon: cat.icon,
      color: cat.color,
      soft: cat.soft,
      meta: [fmtDate(program.date), program.points ? `+${program.points}P` : null].filter(Boolean),
      points: program.points ?? null,
    };
  }
  return {
    title: '프로그램 정보를 볼 수 없는 활동',
    icon: 'ic-grid',
    color: '#64748B',
    soft: '#E9EDF3',
    meta: ['게시가 중단된 프로그램일 수 있어요'],
    points: null,
  };
}

export default function QrCenterModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [active, setActive] = useState(null); // { participation, type, issued }
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const rows = await fetchMyParticipationsWithProgram();
      // 확정 A절: 목록은 아직 완료되지 않은 내 참여만. 완료 건은 아카이브의 몫이다.
      setItems(rows.filter((r) => r.status !== 'completed'));
      setState('ready');
    } catch (err) {
      // 마이그레이션 미적용/네트워크 오류에도 모달이 죽지 않게 한다.
      console.error('[QrCenterModal] 참여 목록 조회 실패:', err);
      setItems([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  async function openQr(participation, type) {
    if (busyId) return;
    setBusyId(participation.id);
    setNotice('');
    try {
      const res = await issueQr({ participationId: participation.id, type });
      if (!res.ok) {
        // 화면 상태가 서버와 어긋난 것이므로 목록을 새로고침한다 (ADR 0005 구현 가이드 2번).
        setNotice(issueRejectText(res.reason));
        await load();
        return;
      }
      setActive({ participation, type, issued: res });
    } catch (err) {
      console.error('[QrCenterModal] QR 발급 실패:', err);
      setNotice('QR을 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusyId(null);
    }
  }

  function backToList() {
    setActive(null);
    setNotice('');
    load();
  }

  return (
    <Modal onClose={onClose} labelledBy="qr-title">
      {active ? (
        <QrView
          participation={active.participation}
          type={active.type}
          issued={active.issued}
          onBack={backToList}
          onClose={onClose}
        />
      ) : (
        <div className="mbody">
          <span className="qtag exit">QR 인증</span>
          <h3 id="qr-title" style={{ marginBottom: 4 }}>
            발급된 QR
          </h3>
          <p className="qr-lead">
            버튼을 누르면 해당 프로그램의 QR이 표시됩니다. 현장 리더기에 인식시키면 입장·퇴장이 인증됩니다.
          </p>

          {notice && <div className="qr-notice">{notice}</div>}

          {state === 'loading' && <div className="empty">참여 목록을 불러오는 중…</div>}

          {state === 'error' && (
            <div className="empty">
              참여 목록을 불러오지 못했어요.
              <br />
              잠시 후 다시 시도해 주세요.
            </div>
          )}

          {state === 'ready' &&
            (items.length === 0 ? (
              // 빈 상태 카피는 프로토타입 1005줄 그대로 (이모지 없음)
              <div className="empty">
                발급된 QR이 없습니다.
                <br />
                프로그램에 참여하면 입퇴장 QR이 발급됩니다.
              </div>
            ) : (
              <div className="qrlist">
                {items.map((it) => {
                  const v = programView(it.program);
                  const isEntry = it.status === 'applied';
                  return (
                    <div className="qi" key={it.id}>
                      <div className="ic" style={{ background: v.soft }}>
                        <Icon name={v.icon} size={20} color={v.color} />
                      </div>
                      <div className="info">
                        <h5>{v.title}</h5>
                        <div className="m">
                          {[...v.meta, STATUS_LABEL[it.status] ?? it.status].join(' · ')}
                        </div>
                      </div>
                      {/* 입장 인증 전에는 퇴장 QR 버튼이 아예 뜨지 않는다. 우회해도 서버가 wrong_order 로 막는다. */}
                      <button
                        type="button"
                        className={isEntry ? 'scanbtn enter' : 'scanbtn exit'}
                        onClick={() => openQr(it, isEntry ? 'entry' : 'exit')}
                        disabled={busyId === it.id}
                      >
                        {busyId === it.id ? '발급 중…' : isEntry ? '입장 QR' : '퇴장 QR'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}

/* ==========================================================================
   QR 표시 (프로토타입 .qrbox 구조 재사용)
   ========================================================================== */

function mmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function QrView({ participation, type, issued: initialIssued, onBack, onClose }) {
  const isEntry = type === 'entry';
  const v = programView(participation.program);

  const { refreshProfile } = useAuth();
  const [issued, setIssued] = useState(initialIssued);
  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const doneRef = useRef(false);

  const payload = useMemo(() => buildQrPayload(issued), [issued]);
  const expiresMs = Date.parse(issued.expires_at);
  const remaining = Number.isNaN(expiresMs) ? 0 : expiresMs - now;
  const expired = remaining <= 0;

  // 남은 유효시간 1초 틱. 이 값은 "표시"일 뿐 판정이 아니다 —
  // 만료 판정의 소유자는 서버의 *_token_expires_at 컬럼이다 (ADR 0005 결정 1-3).
  useEffect(() => {
    if (done) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [done]);

  // 10초 폴링 — 관리자가 스캔하면 화면이 자동으로 완료 상태로 넘어간다.
  useEffect(() => {
    if (done) return undefined;
    const target = isEntry ? 'entered' : 'completed';
    const id = setInterval(async () => {
      try {
        const rows = await fetchParticipationStatuses();
        const mine = rows.find((r) => r.id === participation.id);
        if (!mine || doneRef.current) return;
        if (mine.status === target || (isEntry && mine.status === 'completed')) {
          doneRef.current = true;
          setDone(true);
          // 퇴장 인증이 끝나면 서버가 points_balance 를 올린 상태다. 전역 profile 을 다시 읽어
          // 나브 상단 잔액을 맞춘다 — 안 하면 완료 화면엔 "+400P 적립"이 뜨는데 나브는 그대로라
          // "포인트가 안 들어왔다"로 보인다. 프런트가 값을 계산하는 게 아니라 서버 값을 재조회한다.
          if (!isEntry) {
            refreshProfile?.().catch((err) =>
              console.warn('[QrCenterModal] 잔액 갱신 실패(표시만 지연됨):', err)
            );
          }
        }
      } catch (err) {
        // 폴링 실패는 조용히 넘어간다 — 다음 주기에 다시 시도한다. QR 자체는 여전히 유효하다.
        console.warn('[QrCenterModal] 상태 폴링 실패:', err);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [done, isEntry, participation.id, refreshProfile]);

  async function reissue() {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      // 재발급 = 같은 issueQr() 재호출. 서버가 새 토큰으로 덮어쓰고 이전 토큰은 즉시 무효가 된다.
      const res = await issueQr({ participationId: participation.id, type });
      if (!res.ok) {
        setNotice(issueRejectText(res.reason));
        return;
      }
      setIssued(res);
      setNow(Date.now());
    } catch (err) {
      console.error('[QrCenterModal] QR 재발급 실패:', err);
      setNotice('QR을 다시 발급하지 못했습니다. 잠시 후 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mbody">
        <div className="scan-done">
          <div className="check">
            <Icon name="ic-check" size={38} />
          </div>
          {/* [원칙 4] 큰 문구는 언제나 포트폴리오 서사다. 포인트는 아래 한 줄 보조로만 놓는다. */}
          <h3 id="qr-title">{isEntry ? '입장이 확인되었습니다' : '참여가 기록되었습니다'}</h3>
          <div className="desc">
            {isEntry ? `${v.title} · 퇴장 시 한 번 더 인증해 주세요` : v.title}
          </div>
          {/* 지급 포인트는 클라이언트가 이미 들고 있는 programs.points 로 그린다(폴링은 금액을 돌려주지 않는다).
              amber·작게. 숫자 카운트업/컨페티/사운드 금지 (원칙 1·4). */}
          {!isEntry && v.points != null && <div className="done-pts">+{v.points}P 적립</div>}

          {/* [훅 지점 — 미구현이지 삭제가 아니다]
              CLAUDE.md 6장 3번은 "퇴장 인증 완료 시 만족도 평가(별점+한줄평) 자동 노출"을 요구한다.
              확정 B-1이 reviews 테이블을 다음 스펙(아카이브)으로 미뤘으므로 이번에는 붙이지 않는다.
              reviews 가 생기면 바로 이 자리(퇴장 완료 화면)에 평가 모달을 띄운다. */}

          <button
            type="button"
            className="mbtn"
            style={{ marginTop: 22 }}
            onClick={isEntry ? onBack : onClose}
          >
            {isEntry ? '목록으로' : '확인'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mbody">
      <div className="qrbox">
        <span className={isEntry ? 'qtag' : 'qtag exit'}>{isEntry ? '입장' : '퇴장'} 인증</span>

        <div className={expired ? 'qr is-expired' : 'qr'} style={{ marginTop: 14 }}>
          <QRCodeSVG value={payload} size={164} level="M" bgColor="#FFFFFF" fgColor="#16213E" />
        </div>

        <h3 id="qr-title" style={{ marginTop: 16 }}>
          {v.title}
        </h3>
        <div className="desc">현장의 QR 리더기에 인식시켜 주세요.</div>

        {expired ? (
          <>
            <div className="countdown expired">유효시간이 지났습니다</div>
            <button type="button" className="qr-reissue" onClick={reissue} disabled={busy}>
              <Icon name="ic-refresh" size={16} />
              {busy ? '발급 중…' : '다시 발급받기'}
            </button>
          </>
        ) : (
          <div className="countdown">
            <span className="cdn">{mmss(remaining)}</span>
            남음 · 시간이 지나면 다시 발급받을 수 있어요
          </div>
        )}

        {/* 수동 확인용 코드. 학생은 검증 RPC 호출 권한이 없으므로 자기 토큰을 알아도 스스로 인증할 수 없다
            (스펙 "시연 환경 전제"). 웹캠 인식이 실패할 때 관리자가 이 코드를 직접 입력한다(확정 D-1). */}
        <div className="qr-code-text">
          코드 <b>{issued.token}</b>
        </div>

        {notice && <div className="qr-notice">{notice}</div>}

        <button type="button" className="qr-back" onClick={onBack}>
          목록으로
        </button>
      </div>
    </div>
  );
}
