// Accumu v2 — 관리자 QR 스캔 (docs/specs/qr-dual-auth.md "E. 관리자 — QR 스캔 화면")
//
// [이 화면이 절대 원칙 5의 실물이다] 입장·퇴장 2회 인증을 여기서 처리한다. "한 번만 찍으면 완료" 같은
//   단축 경로를 만들지 않는다. 검증·상태 전이·포인트 지급은 전부 서버(verify_participation_qr)가 하고,
//   이 화면은 토큰 문자열을 전달하고 결과를 표시할 뿐이다 — participations 에 update 정책이 0개다.
//
// [카메라와 수동 입력은 같은 함수를 탄다 — 확정 D-1]
//   handleToken() 하나가 verifyQr()를 호출하고, 카메라 콜백과 수동 입력 폼이 모두 handleToken()을 부른다.
//   입력 수단만 다르고 만료·1회용·순서 검증은 완전히 동일하다(원칙 5의 "단순화"에 해당하지 않는다).
//
// [카메라는 이 프로젝트 최대의 단일 실패 지점이다]
//   권한 거부 / 미지원 / 웹캠 없음 / 보안 컨텍스트 아님을 각각 구분해 안내하고, 어떤 경우에도 화면이 죽지 않는다.
//   에러를 조용히 삼키지 않는다(삼키면 시연 당일 원인을 못 찾는다).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import Icon from '../components/Icon';
import { fetchProgramBrief } from '../lib/programService';
import { VERIFY, extractToken, rejectText, verifyQr } from '../lib/participationService';

/** 성공 토큰 중복 방지용 키. 서버 qr_normalize_token 과 같은 규칙(대문자화 + 구분자 제거)이라
 *  "ab-cde fghjk"와 "ABCDEFGHJK"가 같은 키가 된다. 검증에는 쓰지 않는다 — 판정은 서버가 한다. */
function normalizeForDedup(raw) {
  return extractToken(raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
}
import '../styles/AdminShell.css';

const READER_ID = 'accumu-qr-reader';
/** 같은 코드가 연속으로 읽혀도 서버를 반복 호출하지 않는다. (와도 서버가 used 로 안전하게 처리한다) */
const REPEAT_COOLDOWN_MS = 4000;

/* ---------- 카메라 오류 분류 (인증 거부와 절대 섞지 않는다) ---------- */
const CAMERA_ERROR_TEXT = {
  insecure: {
    title: '이 주소에서는 카메라를 열 수 없습니다',
    desc: '브라우저는 http://localhost 또는 HTTPS에서만 카메라를 허용합니다. PC에서 http://localhost:5173 으로 접속해 주세요. 아래 "코드 직접 입력"으로도 인증할 수 있습니다.',
  },
  denied: {
    title: '카메라 권한이 거부되었습니다',
    desc: '브라우저 주소창의 카메라 아이콘에서 권한을 허용한 뒤 다시 시도해 주세요. 아래 "코드 직접 입력"으로도 인증할 수 있습니다.',
  },
  'no-device': {
    title: '사용할 수 있는 카메라가 없습니다',
    desc: '웹캠이 연결되어 있는지 확인해 주세요. 아래 코드 직접 입력으로도 인증할 수 있습니다.',
  },
  'in-use': {
    title: '카메라를 다른 프로그램이 사용 중입니다',
    desc: '화상회의 앱 등 카메라를 쓰는 프로그램을 종료한 뒤 다시 시도해 주세요.',
  },
  unsupported: {
    title: '이 브라우저는 카메라 스캔을 지원하지 않습니다',
    desc: '최신 Chrome/Edge/Safari에서 다시 시도하거나, 아래 코드 직접 입력을 사용해 주세요.',
  },
  unknown: {
    title: '카메라를 시작하지 못했습니다',
    desc: '다시 시도하거나 아래 코드 직접 입력을 사용해 주세요.',
  },
};

function classifyCameraError(err) {
  const name = err?.name ?? '';
  const msg = String(err?.message ?? err ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|NotAllowed/i.test(msg)) return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || /no camera|not found|NotFound|devices/i.test(msg)) return 'no-device';
  if (name === 'NotReadableError' || name === 'TrackStartError' || /in use|could not start|NotReadable/i.test(msg)) return 'in-use';
  if (name === 'NotSupportedError' || /not supported|getUserMedia|secure context|https/i.test(msg)) return 'unsupported';
  return 'unknown';
}

/** ISO 타임스탬프 -> 'HH:MM:SS' (로컬). 인증 시각 표시용. */
function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function AdminScanPage() {
  const [params] = useSearchParams();
  const programId = params.get('program');

  const [context, setContext] = useState(null); // 관리자 홈에서 넘어온 프로그램(문맥 표시 전용)
  const [camera, setCamera] = useState({ state: 'starting', kind: null });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [manual, setManual] = useState('');

  const scannerRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const lastScanRef = useRef({ text: '', at: 0 });
  const verifyingRef = useRef(false);
  const handleDecodedRef = useRef(() => {});
  // 이번 스캔 세션에서 이미 성공 처리한 토큰들. 화면 표시용 중복 방지일 뿐 서버 판정을 대신하지 않는다
  // (1회용 보장의 소유자는 서버의 status 전이다 — 새로고침하면 이 Set 은 비고 서버가 used 를 돌려준다).
  const succeededRef = useRef(new Set());

  /* ---------- 문맥 표시 (검증에는 쓰지 않는다) ----------
     verify_participation_qr 은 토큰 하나만 받는다. program_id 를 함께 넘기면 선택자가 둘이 되어
     불일치 처리가 늘고, 행 경계는 이미 H-1(created_by = 본인)이 정한다 (ADR 0005 "대안으로 고려했던 것"). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = programId ? await fetchProgramBrief(programId) : null;
      if (!cancelled) setContext(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [programId]);

  /* ---------- 토큰 처리 — 카메라와 수동 입력의 공통 경로 ---------- */
  const handleToken = useCallback(async (raw) => {
    if (verifyingRef.current) return;

    // [성공 처리한 토큰은 다시 검증하지 않는다]
    //   학생 화면은 10초 폴링이라 인증 직후에도 QR 이 최대 10초간 그대로 떠 있고, 학생이 폰을
    //   웹캠 앞에 계속 들고 있는 것은 자연스러운 행동이다. 그때 디바운스(4초)가 풀리면 같은 토큰이
    //   재전송되고, 서버가 정상적으로 used/already_completed 를 돌려주면서 "입장 확인" 패널이
    //   붉은 거부 패널로 덮인다 — 서버는 안전하지만 화면만 실패한 것처럼 보인다.
    //   토큰 단위로 기억해 재호출 자체를 건너뛴다(서버 판정을 바꾸는 게 아니라 중복 조회를 막는 것).
    const key = normalizeForDedup(raw);
    if (key && succeededRef.current.has(key)) return;

    verifyingRef.current = true;
    setVerifying(true);
    try {
      const res = await verifyQr(raw);
      if (res?.outcome === VERIFY.OK && key) succeededRef.current.add(key);
      setResult({ ...res, shownAt: Date.now() });
    } catch (err) {
      // verifyQr 내부에서 잡지 못한 예외까지 화면에 남긴다(조용히 삼키지 않는다).
      console.error('[AdminScan] 검증 중 예외:', err);
      setResult({ outcome: VERIFY.ERROR, errorKind: 'network', reason: String(err?.message ?? err), shownAt: Date.now() });
    } finally {
      verifyingRef.current = false;
      setVerifying(false);
      // 결과 표시 후 별도 조작 없이 다음 스캔 대기 상태로 돌아간다(카메라는 계속 돌고 있다).
    }
  }, []);

  // 카메라 콜백은 start() 시점에 고정되므로 최신 핸들러를 ref 로 넘긴다.
  useEffect(() => {
    handleDecodedRef.current = (decodedText) => {
      const now = Date.now();
      const last = lastScanRef.current;
      // 같은 코드가 초당 여러 번 읽히는 것을 프런트에서 디바운스한다.
      if (decodedText === last.text && now - last.at < REPEAT_COOLDOWN_MS) return;
      lastScanRef.current = { text: decodedText, at: now };
      handleToken(decodedText);
    };
  }, [handleToken]);

  /* ---------- 카메라 시작/정리 ----------
     StrictMode 이중 마운트에서도 start/stop 이 엇갈리지 않도록 프라미스 체인으로 직렬화한다. */
  useEffect(() => {
    let cancelled = false;

    const task = chainRef.current
      .then(async () => {
        if (cancelled) return;
        setCamera({ state: 'starting', kind: null });

        // 보안 컨텍스트 확인이 먼저다. 이걸 건너뛰면 브라우저가 던지는 모호한 오류로만 남는다 (확정 E-1).
        if (typeof window !== 'undefined' && window.isSecureContext === false) {
          setCamera({ state: 'error', kind: 'insecure' });
          return;
        }
        if (!navigator?.mediaDevices?.getUserMedia) {
          setCamera({ state: 'error', kind: 'unsupported' });
          return;
        }

        try {
          const cams = await Html5Qrcode.getCameras(); // 여기서 권한 프롬프트가 뜬다
          if (cancelled) return;
          if (!cams || cams.length === 0) {
            setCamera({ state: 'error', kind: 'no-device' });
            return;
          }
          // 폰이면 후면 카메라, PC면 유일한 웹캠.
          const back = cams.find((c) => /back|rear|environment|후면/i.test(c.label ?? '')) ?? cams[cams.length - 1];

          // [인식 속도] 기본 경로는 자바스크립트 디코더(jsQR)라 프레임마다 픽셀을 직접 훑어 느리다.
          //   useBarCodeDetectorIfSupported 를 켜면 브라우저 내장 BarcodeDetector(네이티브)를 쓴다 —
          //   안드로이드 Chrome 에서 체감 차이가 가장 크고, 미지원 브라우저는 기존 디코더로 자동 폴백한다.
          //   판정 로직은 전혀 바뀌지 않는다: 어느 디코더가 읽든 결과 문자열은 같은 handleToken() 으로 간다.
          const instance = new Html5Qrcode(READER_ID, {
            verbose: false,
            experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          });
          scannerRef.current = instance;
          await instance.start(
            back.id,
            // fps 10 -> 20: 초당 검사 횟수가 두 배가 되어 "맞췄는데 한 박자 늦게 잡히는" 구간이 줄어든다.
            // qrbox 230 -> 280: 인식 영역이 넓어져 학생이 화면을 정확히 맞추지 않아도 잡힌다(현장에서 이게 크다).
            { fps: 20, qrbox: { width: 280, height: 280 }, aspectRatio: 1 },
            (decodedText) => handleDecodedRef.current(decodedText),
            () => {
              /* 프레임마다 "QR 없음"으로 호출된다. 오류가 아니므로 무시한다. */
            }
          );
          if (cancelled) return;
          setCamera({ state: 'running', kind: null });
        } catch (err) {
          console.error('[AdminScan] 카메라 시작 실패:', err);
          if (!cancelled) setCamera({ state: 'error', kind: classifyCameraError(err) });
        }
      })
      .catch(() => {});

    chainRef.current = task;

    return () => {
      cancelled = true;
      chainRef.current = task
        .then(async () => {
          const inst = scannerRef.current;
          scannerRef.current = null;
          if (!inst) return;
          try {
            await inst.stop();
          } catch {
            /* 이미 정지된 경우 */
          }
          try {
            inst.clear();
          } catch {
            /* 이미 정리된 경우 */
          }
        })
        .catch(() => {});
    };
  }, [attempt]);

  function submitManual(e) {
    e.preventDefault();
    const raw = manual.trim();
    if (!raw || verifying) return;
    // [확정 D-1] 카메라와 완전히 동일한 handleToken -> verifyQr -> verify_participation_qr 경로.
    // 대소문자·하이픈·공백이 섞여도 서버 qr_normalize_token() 이 같은 문자열로 만든다.
    handleToken(raw);
    setManual('');
  }

  const camErr = camera.state === 'error' ? CAMERA_ERROR_TEXT[camera.kind] ?? CAMERA_ERROR_TEXT.unknown : null;

  return (
    <section className="screen scan-screen">
      <div className="sec-head">
        <div>
          <div className="eyebrow">QR Scan</div>
          <h2 className="sec">입·퇴장 QR 인증</h2>
          <div className="sec-sub">
            {context
              ? `${context.title} 현장 스캔 · 내가 올린 프로그램의 QR이면 모두 인증됩니다`
              : '학생이 제시한 입장·퇴장 QR을 카메라에 비춰 주세요'}
          </div>
        </div>
      </div>

      <div className="scan-grid">
        {/* ===== 카메라 ===== */}
        <div className="scan-cam">
          <div className="camhead">
            <Icon name="ic-camera" size={18} color="var(--brand)" />
            카메라
            {camera.state === 'running' && <span className="live">스캔 대기 중</span>}
          </div>

          {/* html5-qrcode 가 비디오를 주입하는 컨테이너. 오류 상태에서도 DOM 에 남겨 재시도가 가능하게 한다. */}
          <div className="camview">
            <div id={READER_ID} className={camera.state === 'running' ? 'reader on' : 'reader'} />

            {camera.state === 'starting' && (
              <div className="camoverlay">
                <div className="t">카메라를 여는 중…</div>
                <div className="d">권한 요청이 뜨면 허용을 눌러 주세요.</div>
              </div>
            )}

            {camErr && (
              <div className="camoverlay err">
                <Icon name="ic-alert" size={26} color="var(--rose)" />
                <div className="t">{camErr.title}</div>
                <div className="d">{camErr.desc}</div>
                <button type="button" className="retry" onClick={() => setAttempt((n) => n + 1)}>
                  <Icon name="ic-refresh" size={15} />
                  다시 시도
                </button>
              </div>
            )}
          </div>

          {camera.state === 'running' && <div className="camhint">학생의 QR을 화면 안에 맞춰 주세요.</div>}

          {/* [확정 E-1] 시연 환경 전제를 화면에 남긴다. 이걸 모르면 폰에서 스캔이 안 되는 것을 버그로 오인한다. */}
          <div className="envnote">
            카메라는 <b>http://localhost</b> 또는 <b>HTTPS</b>에서만 열립니다. 학생 화면은 QR을 표시만 하므로
            폰에서 <b>http://192.168.x.x:5173</b> 으로 접속해도 됩니다 (<code>npm run dev -- --host</code>).
          </div>
        </div>

        {/* ===== 결과 패널 ===== */}
        <div className="scan-result">
          <ResultPanel result={result} verifying={verifying} />

          {/* [확정 D-1] 보조 수단임이 드러나도록 접힌 상태로 둔다. 메인 경로는 카메라다. */}
          {/* 카메라가 죽었을 때는 펼쳐서 보여준다 — 접혀 있으면 fallback 을 못 찾는다.
              (메인 경로는 여전히 카메라이고, 정상 상태에서는 접힌 보조 수단으로 남는다 — 확정 D-1) */}
          <details className="manual" open={camera.state === 'error'}>
            <summary>카메라를 쓸 수 없나요?</summary>
            <p>
              학생 QR 아래에 표시된 코드를 그대로 입력하세요. 카메라와 <b>같은 검증</b>을 거칩니다 — 만료·1회용·
              입퇴장 순서가 그대로 적용됩니다.
            </p>
            <form onSubmit={submitManual}>
              <input
                type="text"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="예: A1B2C 3D4E5"
                autoComplete="off"
                spellCheck={false}
                aria-label="QR 코드 직접 입력"
              />
              <button type="submit" disabled={verifying || !manual.trim()}>
                {verifying ? '확인 중…' : '인증'}
              </button>
            </form>
          </details>
        </div>
      </div>
    </section>
  );
}

/* ==========================================================================
   결과 패널 — 성공 / 인증 거부 / 기술 오류를 명확히 구분해 표시한다
   ========================================================================== */
function ResultPanel({ result, verifying }) {
  // 확인 중에는 직전 결과를 그대로 두지 않는다 — 어느 스캔의 결과인지 헷갈리면 안 된다.
  if (verifying) {
    return (
      <div className="rpanel wait">
        <div className="t">인증 확인 중…</div>
        <div className="d">서버에서 토큰을 검증하고 있습니다.</div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="rpanel wait">
        <Icon name="ic-qr" size={26} color="var(--line2)" />
        <div className="t">스캔 결과가 여기에 표시됩니다</div>
        <div className="d">입장·퇴장 각각 한 번씩 인증해야 참여가 완료됩니다.</div>
      </div>
    );
  }

  if (result.outcome === VERIFY.ERROR) {
    // [기술 오류는 인증 거부와 분리한다] 스펙 E절 명시. camera_error / network_error 는 서버 사유가 아니다.
    const isPerm = result.errorKind === 'permission';
    return (
      <div className="rpanel tech">
        <div className="tag">기술 오류</div>
        <div className="t">{isPerm ? '이 계정에는 인증 권한이 없습니다' : '서버와 통신하지 못했습니다'}</div>
        <div className="d">
          {isPerm
            ? '관리자 계정으로 로그인했는지 확인해 주세요. (정상 사용에서는 발생하지 않습니다)'
            : '네트워크 상태를 확인한 뒤 다시 스캔해 주세요.'}
        </div>
        {result.reason && <div className="raw">{result.reason}</div>}
      </div>
    );
  }

  if (result.outcome === VERIFY.REJECTED) {
    const t = rejectText(result.reason);
    return (
      <div className="rpanel deny">
        <div className="tag">
          <Icon name="ic-alert" size={15} />
          인증 거부
        </div>
        <div className="t">{t.title}</div>
        <div className="d">{t.hint}</div>
        {/* 학생/프로그램 정보는 서버가 알려준 범위에서만 표시된다
            (본인이 만든 프로그램임이 확인되기 전에는 아무 식별 정보도 내려오지 않는다 — ADR 0005 결정 4). */}
        {(result.student_name || result.program_title) && (
          <div className="who">{[result.student_name, result.program_title].filter(Boolean).join(' · ')}</div>
        )}
      </div>
    );
  }

  // 성공
  const isEntry = result.type === 'entry';
  return (
    <div className={isEntry ? 'rpanel ok entry' : 'rpanel ok exit'}>
      <div className="tag">
        <Icon name="ic-check" size={15} />
        {isEntry ? '입장 확인' : '퇴장 확인'}
      </div>
      {/* [원칙 4] 퇴장에서도 가장 큰 문구는 "참여가 기록되었습니다"(활동 기록)다.
          지급 포인트는 그 아래 한 줄 보조로만 놓는다 — 포인트를 가장 큰 요소로 만들지 않는다. */}
      <div className="t">{isEntry ? '입장이 확인되었습니다' : '참여가 기록되었습니다'}</div>
      <div className="who">{[result.student_name, result.program_title].filter(Boolean).join(' · ')}</div>
      <div className="d">
        {isEntry ? '퇴장 시 한 번 더 인증해야 참여가 완료됩니다.' : '참여 완료'} · {fmtTime(result.at)}
      </div>
      {!isEntry && result.points_awarded != null && (
        <div className="pts">{result.points_awarded.toLocaleString()}P 지급</div>
      )}
    </div>
  );
}
