import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type LocationContext, expandLocation, portableLocation } from '../src/core/util/locations';

const posix: LocationContext = {
  home: '/home/ada',
  env: { QT_DOCS: '/opt/qt/docs' },
  workspaceFolders: [
    { name: 'app', path: '/work/app' },
    { name: 'lib', path: '/work/lib' },
  ],
  defaultFolders: ['/work/app', '/work/lib'],
  relativeTo: ['/work/app'],
  pathApi: path.posix,
};

describe('expandLocation', () => {
  it('resolves relative paths against the settings file location', () => {
    expect(expandLocation('docs/qch', posix)).toEqual(['/work/app/docs/qch']);
    expect(expandLocation('./docs/../third_party/qch', posix)).toEqual([
      '/work/app/third_party/qch',
    ]);
    expect(expandLocation('docs', { ...posix, relativeTo: ['/work/app', '/work/lib'] })).toEqual([
      '/work/app/docs',
      '/work/lib/docs',
    ]);
    expect(expandLocation('docs', { ...posix, relativeTo: [] })).toEqual([]);
  });

  it('expands home, environment and workspace folder variables', () => {
    expect(expandLocation('~/Qt/Docs', posix)).toEqual(['/home/ada/Qt/Docs']);
    expect(expandLocation('${userHome}/Qt', posix)).toEqual(['/home/ada/Qt']);
    expect(expandLocation('${env:QT_DOCS}/qt6', posix)).toEqual(['/opt/qt/docs/qt6']);
    expect(expandLocation('${env:MISSING}', posix)).toEqual([]);
    expect(expandLocation('${workspaceFolder}/docs', posix)).toEqual([
      '/work/app/docs',
      '/work/lib/docs',
    ]);
    expect(expandLocation('${workspaceFolder:lib}/docs', posix)).toEqual(['/work/lib/docs']);
    expect(expandLocation('${workspaceFolder:unknown}/docs', posix)).toEqual([]);
    expect(expandLocation('  /abs//path/  ', posix)).toEqual(['/abs/path/']);
    expect(expandLocation('   ', posix)).toEqual([]);
  });

  it('handles Windows paths', () => {
    const windows: LocationContext = {
      ...posix,
      home: 'C:\\Users\\ada',
      workspaceFolders: [{ name: 'app', path: 'D:\\work\\app' }],
      defaultFolders: ['D:\\work\\app'],
      relativeTo: ['D:\\work\\app'],
      pathApi: path.win32,
    };
    expect(expandLocation('docs/qch', windows)).toEqual(['D:\\work\\app\\docs\\qch']);
    expect(expandLocation('~\\Qt\\Docs', windows)).toEqual(['C:\\Users\\ada\\Qt\\Docs']);
    expect(expandLocation('${workspaceFolder:app}/docs', windows)).toEqual(['D:\\work\\app\\docs']);
  });
});

describe('portableLocation', () => {
  it('prefers paths relative to the settings file, then named folders, then ~', () => {
    const api = path.posix;
    expect(
      portableLocation('/work/app/docs/qch', {
        home: '/home/ada',
        relativeTo: '/work/app',
        pathApi: api,
      }),
    ).toEqual({
      value: 'docs/qch',
      portable: true,
    });
    expect(
      portableLocation('/work/app', { home: '/home/ada', relativeTo: '/work/app', pathApi: api }),
    ).toEqual({
      value: '.',
      portable: true,
    });
    expect(
      portableLocation('/work/lib/docs', {
        home: '/home/ada',
        relativeTo: '/work',
        namedFolders: [{ name: 'lib', path: '/work/lib' }],
        pathApi: api,
      }),
    ).toEqual({ value: 'lib/docs', portable: true });
    expect(
      portableLocation('/work/lib/docs', {
        home: '/home/ada',
        namedFolders: [{ name: 'lib', path: '/work/lib' }],
        pathApi: api,
      }),
    ).toEqual({ value: '${workspaceFolder:lib}/docs', portable: true });
    expect(
      portableLocation('/home/ada/Qt/Docs', {
        home: '/home/ada',
        relativeTo: '/work/app',
        pathApi: api,
      }),
    ).toEqual({
      value: '~/Qt/Docs',
      portable: true,
    });
    expect(
      portableLocation('/opt/qt/docs', {
        home: '/home/ada',
        relativeTo: '/work/app',
        pathApi: api,
      }),
    ).toEqual({
      value: '/opt/qt/docs',
      portable: false,
    });
  });

  it('writes forward slashes on Windows and never relates paths across drives', () => {
    const api = path.win32;
    expect(
      portableLocation('D:\\work\\app\\docs\\qch', {
        home: 'C:\\Users\\ada',
        relativeTo: 'D:\\work\\app',
        pathApi: api,
      }),
    ).toEqual({
      value: 'docs/qch',
      portable: true,
    });
    expect(
      portableLocation('E:\\docs', {
        home: 'C:\\Users\\ada',
        relativeTo: 'D:\\work\\app',
        pathApi: api,
      }),
    ).toEqual({
      value: 'E:\\docs',
      portable: false,
    });
  });

  it('round-trips through expandLocation', () => {
    const stored = portableLocation('/work/app/docs/qch', {
      home: '/home/ada',
      relativeTo: '/work/app',
      pathApi: path.posix,
    });
    expect(expandLocation(stored.value, posix)).toEqual(['/work/app/docs/qch']);
  });
});
