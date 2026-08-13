// Accumu v2 — 대표 사진 자르기 (ADR 0022 결정 6-1, 케빈 요청 2026-08-13 "어느 부분을 살릴지 고르고 싶어")
//
// [모달이 아니라 폼 안의 패널이다] ProgramFormModal 자체가 이미 Modal 이라, 여기서 Modal 을 또 열면
//   Esc 리스너와 포커스 트랩이 두 벌 겹친다 — Esc 한 번에 자르기 창과 폼이 같이 닫히는 식으로
//   깨진다. 사진 칸 자리에서 미리보기를 대체하는 패널이면 그 문제가 아예 없고, 모바일에서도
//   폼 모달이 거의 화면 폭이라 크기가 아쉽지 않다.
//
// [좌표계 — 세 층을 헷갈리지 말 것]
//   1) 원본 픽셀    : img.naturalWidth/Height. 최종 자르기 좌표를 여기로 환산해 넘긴다.
//   2) 뷰포트 px    : 화면에 보이는 자르기 창(vw × vh). 비율은 카드 썸네일과 같다.
//   3) 표시 크기    : 원본 × scale. scale = base(꽉 채우는 최소 배율) × zoom.
//   offset 은 뷰포트 좌상단 기준으로 이미지 좌상단이 어디 있는지(항상 0 이하)다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../Icon';
import { PROGRAM_IMAGE_RATIO, ProgramImageError, renderCropToBlob } from '../../lib/programService';

const MAX_ZOOM = 4;
const NUDGE_PX = 12; // 방향키 한 번에 움직이는 거리

/** 이미지가 뷰포트를 항상 덮도록 offset 을 가둔다(빈 공간이 생기지 않는다). */
function clampOffset(o, vw, vh, dw, dh) {
  return {
    x: Math.min(0, Math.max(vw - dw, o.x)),
    y: Math.min(0, Math.max(vh - dh, o.y)),
  };
}

export default function ImageCropper({ file, busy = false, onCancel, onConfirm }) {
  const viewportRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);
  const pointersRef = useRef(new Map()); // 지금 내려가 있는 포인터들 (핀치 판정용)
  const pinchRef = useRef(null); // { dist, zoom } — 두 손가락이 내려간 순간의 기준값

  // [useMemo + cleanup 전용 effect] effect 본문에서 setState 로 URL 을 넣으면 렌더가 한 번 더 돌고
  //   프로젝트 lint 규칙(set-state-in-effect)에도 걸린다. 생성은 렌더 중에, 해제만 effect 에서.
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const [nat, setNat] = useState(null); // 원본 크기 { w, h } — <img> onLoad 에서 채운다
  const [vw, setVw] = useState(0); // 뷰포트 실제 폭(px)
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(null); // null = 아직 안 건드림(가운데)
  const [err, setErr] = useState(null);

  // 뷰포트 폭은 모달 폭·화면 회전에 따라 변한다. observe 직후 첫 콜백이 곧바로 오므로 초기 측정도 겸한다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setVw(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (!nat || !vw) return null;
    const vh = vw / PROGRAM_IMAGE_RATIO;
    // base = 뷰포트를 꼭 덮는 최소 배율. zoom=1 이 "여백 없이 가장 많이 담는" 상태다.
    const base = Math.max(vw / nat.w, vh / nat.h);
    const scale = base * zoom;
    return { vh, base, scale, dw: nat.w * scale, dh: nat.h * scale };
  }, [nat, vw, zoom]);

  // 실제로 그릴 위치. offset 을 아직 안 건드렸으면 가운데를 쓴다(= 자동 가운데 자르기와 같은 결과).
  const view = useMemo(() => {
    if (!geo) return null;
    const centered = { x: (vw - geo.dw) / 2, y: (geo.vh - geo.dh) / 2 };
    return clampOffset(offset ?? centered, vw, geo.vh, geo.dw, geo.dh);
  }, [geo, offset, vw]);

  const onImgLoad = (e) => {
    const el = e.currentTarget;
    setNat({ w: el.naturalWidth, h: el.naturalHeight });
  };

  /**
   * 확대/축소를 **anchor(뷰포트 좌표) 기준**으로 적용한다. 슬라이더·핀치·휠이 전부 이걸 쓴다.
   * 좌상단 기준으로 확대하면 보고 있던 피사체가 화면 밖으로 밀려나 매번 다시 끌어와야 한다.
   */
  const applyZoom = useCallback(
    (nextRaw, ax, ay) => {
      if (!geo || !view || !nat) return;
      const next = Math.min(MAX_ZOOM, Math.max(1, nextRaw));
      const k = next / zoom;
      const dw2 = nat.w * geo.base * next;
      const dh2 = nat.h * geo.base * next;
      setOffset(
        clampOffset({ x: ax - (ax - view.x) * k, y: ay - (ay - view.y) * k }, vw, geo.vh, dw2, dh2)
      );
      setZoom(next);
    },
    [geo, view, nat, vw, zoom]
  );

  // 슬라이더는 뷰포트 한가운데를 기준으로 확대한다.
  const handleZoom = (e) => {
    if (!geo) return;
    applyZoom(Number(e.target.value), vw / 2, geo.vh / 2);
  };

  // [휠 확대 — passive:false 가 필요해서 네이티브로 단다]
  //   React 의 onWheel 로는 preventDefault 가 먹지 않아, 확대하려던 휠이 폼 모달을 스크롤시킨다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // exp 를 쓰면 확대/축소가 대칭이다(같은 양을 굴리면 정확히 원위치).
      applyZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, zoom]);

  // 포인터 이벤트 하나로 마우스·터치·펜을 다 받는다. setPointerCapture 덕에 창 밖으로 끌어도 끊기지 않는다.
  // [두 손가락 핀치 — 케빈 요청 2026-08-13] 뷰포트에 touch-action:none 을 걸어 드래그를 살린 대가로
  //   브라우저 기본 핀치까지 막혀 있다. 폰에서 확대하려면 슬라이더를 찾아 끌어야 해서 어색했다.
  //   내려간 포인터를 Map 으로 세고 2개가 되면 그 사이 거리 변화를 배율로, 중점을 anchor 로 쓴다.
  const onPointerDown = (e) => {
    if (!view || busy) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pts = pointersRef.current;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2) {
      // 두 손가락이면 이동은 핀치가 맡는다 — 드래그와 동시에 굴러가면 그림이 튄다.
      dragRef.current = null;
      const [a, b] = [...pts.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    } else {
      dragRef.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y };
    }
  };

  const onPointerMove = (e) => {
    const pts = pointersRef.current;
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pinch = pinchRef.current;
    if (pts.size >= 2 && pinch && pinch.dist > 0) {
      const [a, b] = [...pts.values()];
      const r = viewportRef.current?.getBoundingClientRect();
      if (!r) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      applyZoom(pinch.zoom * (dist / pinch.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }

    const d = dragRef.current;
    if (!d || !geo) return;
    setOffset(
      clampOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, vw, geo.vh, geo.dw, geo.dh)
    );
  };

  const onPointerUp = (e) => {
    const pts = pointersRef.current;
    pts.delete(e.pointerId);
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    if (pts.size < 2) pinchRef.current = null;
    // 한 손가락이 남으면 **그 지점부터** 이동을 다시 시작한다 — 안 하면 남은 손가락이
    // 처음 내려놓은 좌표를 기준으로 계산돼 그림이 확 튄다.
    if (pts.size === 1 && view) {
      const [p] = [...pts.values()];
      dragRef.current = { px: p.x, py: p.y, ox: view.x, oy: view.y };
    } else if (pts.size === 0) {
      dragRef.current = null;
    }
  };

  // 마우스를 못 쓰는 경우를 위해 방향키로도 옮길 수 있게 한다(뷰포트가 tabIndex=0 이다).
  const onKeyDown = (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || !geo || !view) return;
    e.preventDefault();
    setOffset(
      clampOffset(
        { x: view.x + d[0] * NUDGE_PX, y: view.y + d[1] * NUDGE_PX },
        vw,
        geo.vh,
        geo.dw,
        geo.dh
      )
    );
  };

  const handleConfirm = useCallback(async () => {
    if (!geo || !view || !imgRef.current) return;
    setErr(null);
    try {
      // 뷰포트에 보이는 영역을 원본 픽셀 좌표로 환산한다. offset 이 음수라 부호를 뒤집는다.
      const blob = await renderCropToBlob(imgRef.current, {
        sx: -view.x / geo.scale,
        sy: -view.y / geo.scale,
        sw: vw / geo.scale,
        sh: geo.vh / geo.scale,
      });
      onConfirm(blob);
    } catch (e2) {
      console.error('[ImageCropper] 자르기 실패:', e2);
      setErr(e2 instanceof ProgramImageError ? e2.message : '이미지를 변환하지 못했습니다.');
    }
  }, [geo, view, vw, onConfirm]);

  return (
    <div className="pf-crop">
      <div
        className="pf-crop-view"
        ref={viewportRef}
        role="application"
        aria-label="사진에서 보여줄 영역 고르기. 드래그하거나 방향키로 옮기고, 두 손가락 또는 휠로 확대하세요."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <img
          ref={imgRef}
          src={url}
          alt=""
          draggable={false}
          onLoad={onImgLoad}
          onError={() => setErr('이미지를 읽지 못했습니다. 다른 파일로 시도해 주세요.')}
          style={
            view && geo
              ? { width: geo.dw, height: geo.dh, transform: `translate(${view.x}px, ${view.y}px)` }
              : { opacity: 0 }
          }
        />
      </div>

      <div className="pf-crop-zoom">
        <Icon name="ic-search" size={14} />
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={handleZoom}
          disabled={busy || !geo}
          aria-label="확대"
        />
      </div>

      {err ? (
        <p className="pf-msg err">{err}</p>
      ) : (
        <p className="pf-msg hint">
          드래그해서 위치를 맞추고, <b>두 손가락(또는 휠·슬라이더)</b>으로 확대하세요.{' '}
          <b>이 창에 보이는 그대로</b> 잘려서 학생 카드와 참여 팝업에 올라갑니다.
        </p>
      )}

      <div className="pf-crop-acts">
        <button type="button" className="pf-photo-btn ghost" onClick={onCancel} disabled={busy}>
          취소
        </button>
        <button
          type="button"
          className="pf-photo-btn"
          onClick={handleConfirm}
          disabled={busy || !view}
        >
          <Icon name="ic-check" size={15} />
          {busy ? '올리는 중…' : '이 영역으로 자르기'}
        </button>
      </div>
    </div>
  );
}
