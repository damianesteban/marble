import { Task } from 'fp-ts/lib/Task';
import { pipe } from 'fp-ts/lib/function';
import { of, merge, firstValueFrom, lastValueFrom } from 'rxjs';
import { mapTo, take, toArray, delay, mergeMap, map } from 'rxjs/operators';
import { createMockEffectContext, createHttpResponse, createHttpRequest, createTestRoute } from '../../+internal/testing.util';
import { HttpEffect, HttpErrorEffect, HttpOutputEffect } from '../../effects/http.effects.interface';
import { Routing } from '../http.router.interface';
import { resolveRouting } from '../http.router.resolver';
import { factorizeRegExpWithParams } from '../http.router.params.factory';
import { HttpError } from '../../error/http.error.model';
import { HttpStatus } from '../../http.interface';

describe('#resolveRouting', () => {
  test('resolves routes inside collection', async () => {
    // given
    const ctx = createMockEffectContext();
    const response = createHttpResponse();

    const path1 = factorizeRegExpWithParams('/');
    const path2 = factorizeRegExpWithParams('/group');
    const path3 = factorizeRegExpWithParams('/group/:id/foo');

    const e1$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test_1' }));
    const e2$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test_2' }));
    const e3$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test_3' }));
    const e4$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test_4' }));

    const req1 = createHttpRequest(({ url: '/', method: 'GET', response }));
    const req2 = createHttpRequest(({ url: '/', method: 'POST', response }));
    const req3 = createHttpRequest(({ url: '/group', method: 'GET', response }));
    const req4 = createHttpRequest(({ url: '/group/123/foo', method: 'POST', response }));
    const req5 = createHttpRequest(({ url: '/unknown', method: 'GET', response }));

    const routing: Routing = [
      {
        regExp: path1.regExp,
        path: path1.path,
        methods: { GET: { effect: e1$, middlewares: [] }, POST: { effect: e2$, middlewares: [] } },
      },
      {
        regExp: path2.regExp,
        path: path2.path,
        methods: { GET: { effect: e3$, middlewares: [], parameters: ['id'] } },
      },
      {
        regExp: path3.regExp,
        path: path3.path,
        methods: { POST: { effect: e4$, middlewares: [] } },
      },
    ];

    // when
    const { resolve, outputSubject } = resolveRouting({ routing, ctx });

    // then
    const resultPromise = lastValueFrom(pipe(
      outputSubject,
      take(4),
      toArray(),
    ));

    resolve(req1);
    resolve(req2);
    resolve(req3);
    resolve(req4);
    resolve(req5);

    const result = await resultPromise;

    expect(result[0]).toEqual({ body: 'test_1', request: req1 });
    expect(result[1]).toEqual({ body: 'test_2', request: req2 });
    expect(result[2]).toEqual({ body: 'test_3', request: req3 });
    expect(result[3]).toEqual({ body: 'test_4', request: req4 });
  });

  test('resolves `HttpEffect` only once', async () => {
    // given
    const effectSpy = jest.fn();
    const ctx = createMockEffectContext();
    const routes = [createTestRoute({ effectSpy })];
    const routing: Routing = routes.map(route => route.item);

    // when
    const { resolve, response$ } = resolveRouting({ routing, ctx });

    const run: Task<any> = () => {
      resolve(routes[0].req); // first call
      resolve(routes[0].req); // second call

      return pipe(response$, take(2), toArray(), lastValueFrom);
    };

    await run();

    // then
    expect(effectSpy).toHaveBeenCalledTimes(1);
  });

  test('resolves `HttpOutputEffect` only once', async () => {
    // given
    const effectSpy = jest.fn();
    const ctx = createMockEffectContext();
    const routes = [createTestRoute()];
    const routing: Routing = routes.map(route => route.item);

    // given - output effect
    const output$: HttpOutputEffect = out$ => (effectSpy(), out$);

    // when
    const { resolve, response$ } = resolveRouting({ routing, ctx, output$ });

    const run: Task<any> = () => {
      resolve(routes[0].req); // first call
      resolve(routes[0].req); // second call

      return pipe(response$, take(2), toArray(), lastValueFrom);
    };

    await run();

    // then
    expect(effectSpy).toHaveBeenCalledTimes(1);
  });

  test('resolves `HttpErrorEffect` only once', async () => {
    // given
    const effectSpy = jest.fn();
    const ctx = createMockEffectContext();
    const routes = [createTestRoute({ throwError: true })];
    const routing: Routing = routes.map(route => route.item);

    // given - error effect
    const error$: HttpErrorEffect = error$ => {
      effectSpy();
      return error$.pipe(map(({ request }) => ({ request, body: 'ERROR' })));
    };

    // when
    const { resolve, response$ } = resolveRouting({ routing, ctx, error$ });

    const run: Task<any> = () => {
      resolve(routes[0].req); // first call
      resolve(routes[0].req); // second call

      return pipe(response$, take(2), toArray(), lastValueFrom);
    };

    await run();

    // then
    expect(effectSpy).toHaveBeenCalledTimes(1);
  });

  test(`returns ${HttpStatus.NOT_FOUND} (Not Found) response if route cannot be resolved`, async () => {
    // given
    const ctx = createMockEffectContext();
    const response = createHttpResponse();
    const request = createHttpRequest(({ url: '/unknown', method: 'GET', response }));
    const path = factorizeRegExpWithParams('/');

    const effect$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test' }));

    const routing: Routing = [{
      regExp: path.regExp,
      path: path.path,
      methods: { GET: { effect: effect$, middlewares: [] } },
    }];

    // when
    const { resolve, errorSubject } = resolveRouting({ routing, ctx });
    const errorPromise = firstValueFrom(errorSubject);

    resolve(request);

    // then
    await expect(errorPromise).resolves.toEqual({
      request,
      error: new HttpError('Route not found', HttpStatus.NOT_FOUND),
    });
  });

  test(`returns ${HttpStatus.BAD_REQUEST} (Bad Request) response in case of malformed URL`, async () => {
    // given
    const ctx = createMockEffectContext();
    const response = createHttpResponse();
    const request = createHttpRequest(({ url: '/group/%test', method: 'GET', response }));
    const path = factorizeRegExpWithParams('/group/:id');

    const effect$: HttpEffect = req$ => req$.pipe(mapTo({ body: 'test' }));

    const routing: Routing = [{
      regExp: path.regExp,
      path: path.path,
      methods: { GET: { effect: effect$, middlewares: [], parameters: path.parameters } },
    }];

    // when
    const { resolve, errorSubject } = resolveRouting({ routing, ctx });
    const errorPromise = firstValueFrom(errorSubject);

    resolve(request);

    // then
    await expect(errorPromise).resolves.toEqual({
      request,
      error: new HttpError('URI malformed', HttpStatus.BAD_REQUEST),
    });
  });

  test('handles concurrent requests for the same path', done => {
    // given
    const delays = [10, 20, 30, 40];
    const ctx = createMockEffectContext();
    const path = factorizeRegExpWithParams('/delay/:delay');
    const testData = delays.map(delay => createHttpRequest(({ url: `/delay/${delay}`, method: 'GET' })));

    const effect: HttpEffect = req$ =>
      req$.pipe(
        map(req => req.params as { delay: number }),
        mergeMap(params => of({}).pipe(
          delay(params.delay),
          mapTo({ body: `delay_${params.delay}` }),
        )),
      );

    const routing: Routing = [{
      regExp: path.regExp,
      path: path.path,
      methods: { GET: { effect: effect, middlewares: [], parameters: ['delay'] } },
    }];

    // when
    const { resolve, outputSubject } = resolveRouting({ routing, ctx });
    const run = () => {
      resolve(testData[0]); // 10 delay
      resolve(testData[3]); // 40 delay
      resolve(testData[2]); // 30 delay
      resolve(testData[1]); // 20 delay
    };

    // then
    outputSubject.pipe(take(4), toArray()).subscribe(
      result => {
        expect(result[0]).toEqual({ body: 'delay_10', request: testData[0] });
        expect(result[1]).toEqual({ body: 'delay_20', request: testData[1] });
        expect(result[2]).toEqual({ body: 'delay_30', request: testData[2] });
        expect(result[3]).toEqual({ body: 'delay_40', request: testData[3] });
        done();
      },
    );

    run();
  });

  test('handles concurrent requests for different paths', done => {
    // given
    const ctx = createMockEffectContext();

    const testData = [
      createTestRoute({ delay: 10 }), // [0] GET /delay_10
      createTestRoute({ delay: 20 }), // [1] GET /delay_20
      createTestRoute({ delay: 30 }), // [2] GET /delay_30
      createTestRoute({ delay: 40 }), // [3] GET /delay_40
    ];

    const routing: Routing = testData.map(route => route.item);

    // when
    const { resolve, outputSubject } = resolveRouting({ routing, ctx });
    const run = () => {
      resolve(testData[0].req); // 10 delay
      resolve(testData[3].req); // 40 delay
      resolve(testData[2].req); // 30 delay
      resolve(testData[1].req); // 20 delay
    };

    // then
    outputSubject.pipe(take(4), toArray()).subscribe(
      result => {
        expect(result[0]).toEqual({ body: 'delay_10', request: testData[0].req });
        expect(result[1]).toEqual({ body: 'delay_20', request: testData[1].req });
        expect(result[2]).toEqual({ body: 'delay_30', request: testData[2].req });
        expect(result[3]).toEqual({ body: 'delay_40', request: testData[3].req });
        done();
      },
    );

    run();
  });

  test('handles concurrent requests for different paths even if one request throws an error', done => {
    // given
    const ctx = createMockEffectContext();

    const testData = [
      createTestRoute({ delay: 10 }),                   // [0] GET /delay_10
      createTestRoute({ delay: 20, throwError: true }), // [1] GET /delay_20
      createTestRoute({ delay: 30 }),                   // [2] GET /delay_30
      createTestRoute({ delay: 40 }),                   // [3] GET /delay_40
    ];

    const routing: Routing = testData.map(route => route.item);

    // when
    const { resolve, outputSubject, errorSubject } = resolveRouting({ routing, ctx });
    const run = () => {
      resolve(testData[0].req); // 10 delay
      resolve(testData[1].req); // 20 delay
      resolve(testData[2].req); // 30 delay
      resolve(testData[3].req); // 40 delay
    };

    // then
    merge(
      outputSubject.pipe(take(3)),
      errorSubject.pipe(take(1), map(res => res.error)),
    ).pipe(
      toArray(),
    ).subscribe(
      result => {
        expect(result[0]).toEqual({ body: 'delay_10', request: testData[0].req });
        expect(result[1]).toEqual(new Error());
        expect(result[2]).toEqual({ body: 'delay_30', request: testData[2].req });
        expect(result[3]).toEqual({ body: 'delay_40', request: testData[3].req });
        done();
      },
    );

    run();
  });
});
