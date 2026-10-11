import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: undefined as unknown,
  zoomIndex: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
}));
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (value: unknown) => {
    const index = harness.refCursor++;
    return (harness.refs[index] ??= { current: value });
  },
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useState: (initial: () => number) => {
    harness.zoomIndex = initial();
    return [
      harness.zoomIndex,
      (update: (previous: number) => number) => {
        harness.zoomIndex = update(harness.zoomIndex);
      },
    ];
  },
}));
vi.mock('@use-gesture/react', () => ({
  useGesture: (handlers: unknown) => {
    harness.handlers = handlers;
  },
}));
import ZoomGestureHandler from '../src/components/VirtualizedZoomGrid/ZoomGestureHandler';
import { useZoomLevel } from '../src/components/VirtualizedZoomGrid/useZoomLevel';

type Handlers = {
  onPinch: (state: { offset: number[]; first?: boolean }) => void;
  onPinchEnd: () => void;
};
function setup(disabled = false, onZoom = vi.fn()) {
  ZoomGestureHandler({ children: null, onZoom, disabled });
  const handlers = harness.handlers as Handlers;
  return {
    onZoom,
    pinch: (scales: number[]) => {
      scales.forEach((scale, index) => handlers.onPinch({ offset: [scale], first: index === 0 }));
      handlers.onPinchEnd();
    },
  };
}
beforeEach(() => {
  harness.handlers = undefined;
  harness.refs = [];
  harness.refCursor = 0;
});
describe('gallery pinch movement', () => {
  it('forwards smooth movement with the correct sign and no loss', () => {
    const h = setup();
    h.pinch(Array.from({ length: 101 }, (_, index) => 1 + index / 100));
    expect(h.onZoom).toHaveBeenCalledTimes(100);
    expect(h.onZoom.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBeCloseTo(-100);
    expect(h.onZoom.mock.calls.every(([delta, discrete]) => delta < 0 && discrete === false)).toBe(
      true
    );
  });
  it('rebases consecutive gestures at their persistent offsets', () => {
    const h = setup();
    h.pinch([1, 1.2]);
    h.pinch([1.2, 1.3]);
    h.pinch([2.7, 2.8]);
    expect(h.onZoom.mock.calls.map(([delta]) => delta)).toEqual([
      expect.closeTo(-20),
      expect.closeTo(-10),
      expect.closeTo(-10),
    ]);
  });
  it('preserves direction reversals and ignores stationary frames', () => {
    const h = setup();
    h.pinch([1, 1.1, 1.1, 1.05, 0.9]);
    expect(h.onZoom.mock.calls.map(([delta]) => delta)).toEqual([
      expect.closeTo(-10),
      expect.closeTo(5),
      expect.closeTo(15),
    ]);
  });
  it('does not zoom while disabled', () => {
    const h = setup(true);
    h.pinch([1, 1.2, 2]);
    expect(h.onZoom).not.toHaveBeenCalled();
  });
  it('rebases movement while disabled so re-enabling does not catch up', () => {
    const onZoom = vi.fn();
    const render = (disabled: boolean) => {
      harness.refCursor = 0;
      ZoomGestureHandler({ children: null, onZoom, disabled });
      return harness.handlers as Handlers;
    };
    let handlers = render(false);
    handlers.onPinch({ offset: [1], first: true });
    handlers.onPinch({ offset: [1.1] });
    handlers = render(true);
    handlers.onPinch({ offset: [1.7] });
    handlers = render(false);
    handlers.onPinch({ offset: [1.8] });
    expect(onZoom.mock.calls.map(([delta]) => delta)).toEqual([
      expect.closeTo(-10),
      expect.closeTo(-10),
    ]);
  });
  it('feeds smooth frames through the actual zoom threshold across gestures', () => {
    const zoom = useZoomLevel();
    const start = harness.zoomIndex;
    const h = setup(false, vi.fn(zoom.handleZoomGesture));
    h.pinch(Array.from({ length: 41 }, (_, index) => 1 + index / 100));
    expect(harness.zoomIndex).toBe(start);
    h.pinch([1.4, 1.6]);
    expect(harness.zoomIndex).toBe(start - 1);
    h.pinch(Array.from({ length: 71 }, (_, index) => 1.6 - index / 100));
    expect(harness.zoomIndex).toBe(start);
  });
});
