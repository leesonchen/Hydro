import fs from 'fs';
import { dirname, join } from 'path';
import { sentryWebpackPlugin } from '@sentry/webpack-plugin';
import { CleanWebpackPlugin } from 'clean-webpack-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { version as coreJsVersion } from 'core-js/package.json';
import compat from 'core-js-compat';
import { EsbuildPlugin } from 'esbuild-loader';
import { DuplicatesPlugin } from 'inspectpack/plugin';
import ExtractCssPlugin from 'mini-css-extract-plugin';
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';
import packageJson from 'package-json';
import { gt } from 'semver';
import webpack from 'webpack';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import { WebpackManifestPlugin } from 'webpack-manifest-plugin';
import WebpackBar from 'webpackbar';
import { version } from '../../package.json';
import prepareXiaolaiFont from '../downloadXiaolaiFont';
import root from '../utils/root';

const baseVersion = (version || '').split('-')[0];

const {
  list,
  targets,
} = compat({
  targets: '> 1%, chrome 70, firefox 90, safari 16, ios_saf 16, not ie 11, not op_mini all',
  modules: [
    'core-js/stable',
  ],
  exclude: [],
  version: coreJsVersion,
  inverse: false,
});
fs.writeFileSync(root('__core-js.js'), `${list.map((i) => `import 'core-js/modules/${i}';`).join('\n')}\n`);

export default async function (env: {
  watch?: boolean, production?: boolean, measure?: boolean, dev?: boolean,
} = {}) {
  // Keep normal builds offline-safe; include the optional font only if locally available.
  await prepareXiaolaiFont();
  if (env.production) console.log(targets);
  let createSentryRelease = !!(process.env.CI && process.env.SENTRY_AUTH_TOKEN);
  if (createSentryRelease) {
    const { version: latest } = await packageJson('@hydrooj/ui-default', { version: 'latest' });
    createSentryRelease = typeof version === 'string' && gt(version, latest);
  }

  function esbuildLoader() {
    return {
      loader: 'esbuild-loader',
      options: {
        loader: 'tsx',
        target: ['es2020', 'chrome70', 'firefox90', 'safari16'],
        sourcemap: true,
      },
    };
  }

  function cssLoader() {
    return {
      loader: 'css-loader',
      options: { importLoaders: 1 },
    };
  }

  function postcssLoader() {
    return {
      loader: 'postcss-loader',
      options: { postcssOptions: { sourceMap: false, config: root('postcss.config.js') } },
    };
  }

  function extractCssLoader() {
    return {
      loader: ExtractCssPlugin.loader,
      // FIXME auto?
      options: {
        publicPath: '',
      },
    };
  }

  function stylusLoader() {
    return {
      loader: 'stylus-loader',
      options: {
        stylusOptions: {
          paths: [root()],
          import: [root('common/common.inc.styl')],
          use: [require('rupture')()],
        },
      },
    };
  }

  function scssLoader() {
    return {
      loader: 'sass-loader',
      options: {
      },
    };
  }

  const config: import('webpack').Configuration = {
    // bail: !env.production,
    mode: (env.production || env.measure) ? 'production' : 'development',
    profile: env.measure,
    context: root(),
    stats: {
      preset: 'errors-warnings',
    },
    // sentry requires source-map while keep it simple in dev mode
    devtool: env.production ? 'source-map' : false,
    entry: {
      [`hydro-${baseVersion}`]: './entry.js',
      sentry: './sentry.ts',
      'default.theme': './theme/default.js',
      'service-worker': './service-worker.ts',
    },
    cache: {
      type: 'filesystem',
      cacheDirectory: root('../../.cache'),
      idleTimeout: 30000,
      buildDependencies: {
        config: [__filename],
      },
    },
    output: {
      path: root('public'),
      publicPath: '/', // overwrite in entry.js
      workerPublicPath: '/',
      hashFunction: 'sha1',
      hashDigest: 'hex',
      hashDigestLength: 10,
      filename: '[name].js?[contenthash:6]',
      chunkFilename: '[name].[chunkhash:6].chunk.js',
    },
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.cjs'],
      alias: {
        vj: root().replace(/\\/g, '/'),
        '~vj': root().replace(/\\/g, '/'),
        jquery: require.resolve('jquery'),
        'react/jsx-runtime': require.resolve('react/jsx-runtime'),
        react: require.resolve('react'),
        'react-dom/client': require.resolve('react-dom/client'),
        'react-dom/server': join(dirname(require.resolve('react-dom/package.json')), 'server.browser.js'),
        'react-dom': require.resolve('react-dom'),
        rupture: require.resolve('rupture'),
      },
    },
    module: {
      rules: [
        {
          test: /\.svg$/i,
          oneOf: [
            {
              issuer: /\.[jt]sx?$/,
              resourceQuery: /react/,
              use: { loader: '@svgr/webpack', options: { icon: true } },
            },
            {
              type: 'asset/resource',
            },
          ],
        },
        {
          resourceQuery: /inline/,
          type: 'asset/inline',
        },
        {
          test: /codicon\.ttf$/i,
          type: 'asset/inline',
        },
        {
          test: /\.(ttf|eot|woff|woff2|png|jpg|jpeg|gif)$/,
          exclude: /codicon\.ttf$/i,
          type: 'asset/resource',
          generator: {
            filename: (pathData) => {
              const p = pathData.module.resource.replace(/\\/g, '/');
              const filename = p.split('/').pop();
              if (p.includes('node_modules')) {
                const extra = p.split('node_modules/').pop();
                const moduleName = extra.split('/')[0];
                if (extra.includes('@fontsource')) {
                  return `fonts/${filename}?[hash:6]`;
                }
                if (['katex', 'monaco-editor'].includes(moduleName)) {
                  return `modules/${moduleName}/${filename}?[hash:6]`;
                }
                return `modules/${extra.substr(1)}?[hash:6]`;
              }
              if (p.includes('.iconfont')) return `${filename}?[hash:6]`;
              return `${p.split('ui-default')[1].substring(1)}?[hash:6]`;
            },
          },
        },
        {
          test: /\.ts$/,
          include: /@types[\\/]/,
          type: 'asset/inline',
          generator: {
            dataUrl: (buf) => buf.toString(),
          },
        },
        {
          test: /\.[mc]?[jt]sx?$/,
          exclude: [/@types[\\/]/, /components[\\/]message[\\/]/, /entry\.js/],
          type: 'javascript/auto',
          use: [esbuildLoader()],
        },
        {
          test: /\.[mc]?[jt]sx?$/,
          include: [/components[\\/]message[\\/]/, /entry\.js/],
          type: 'javascript/auto',
          use: [{
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          }],
        },
        {
          test: /\.styl$/,
          use: [extractCssLoader(), cssLoader(), postcssLoader(), stylusLoader()],
        },
        {
          test: /\.scss$/,
          use: [extractCssLoader(), cssLoader(), postcssLoader(), scssLoader()],
        },
        {
          test: /\.css$/,
          use: [extractCssLoader(), cssLoader(), postcssLoader()],
        },
      ],
    },
    experiments: {
      asyncWebAssembly: true,
      syncWebAssembly: true,
    },
    optimization: {
      splitChunks: {
        minSize: 64000,
        maxAsyncRequests: 10,
        maxInitialRequests: 7,
        automaticNameDelimiter: '-',
        cacheGroups: {
          style: {
            priority: 99,
            name: 'theme',
            type: 'css/mini-extract',
            chunks: 'all',
            enforce: true,
          },
          vendors: {
            test: /[\\/]node_modules[\\/].+\.(m?[jt]sx?|json|yaml)$/,
            priority: -10,
            name(module) {
              const packageName = module.context.replace(/\\/g, '/').split('node_modules/').pop().split('/')[0];
              if (packageName === 'monaco-editor-nls') {
                return `i.monaco.${(module as any).userRequest.replace(/\\/g, '/').split('/').pop().split('.')[0]}`;
              }
              return `n.${packageName.replace('@', '')}`;
            },
            reuseExistingChunk: true,
          },
          default: {
            priority: -20,
            reuseExistingChunk: true,
          },
        },
      },
      usedExports: true,
      minimizer: [new EsbuildPlugin({
        css: true,
        minify: true,
        minifySyntax: true,
        minifyWhitespace: true,
        minifyIdentifiers: true,
        treeShaking: true,
        target: [
          'chrome70',
        ],
        exclude: [/mathmaps/, /\.min\.js$/],
      })],
      moduleIds: env.production ? 'deterministic' : 'named',
      chunkIds: env.production ? 'deterministic' : 'named',
    },
    plugins: [
      new CleanWebpackPlugin(),
      new WebpackBar(),
      new webpack.ProvidePlugin({
        $: 'jquery',
        jQuery: 'jquery',
        'window.jQuery': 'jquery',
        React: 'react',
        monaco: 'monaco-editor/esm/vs/editor/editor.api',
      }),
      new ExtractCssPlugin({
        filename: `[name]-${baseVersion}.css?[fullhash:6]`,
      }),
      new WebpackManifestPlugin({}),
      new webpack.IgnorePlugin({ resourceRegExp: /(^\.\/locale$)/ }),
      new CopyWebpackPlugin({
        patterns: [
          { from: root('static') },
          { from: root('misc/fonts/OFL.txt'), to: 'misc/fonts/OFL.txt' },
          { from: root('components/navigation/nav-logo-small_dark.png'), to: 'components/navigation/nav-logo-small_dark.png' },
          { from: root(`${dirname(require.resolve('streamsaver/package.json'))}/mitm.html`), to: 'streamsaver/mitm.html' },
          { from: root(`${dirname(require.resolve('streamsaver/package.json'))}/sw.js`), to: 'streamsaver/sw.js' },
          { from: `${dirname(require.resolve('monaco-themes/package.json'))}/themes`, to: 'monaco/themes/' },
        ],
      }),
      sentryWebpackPlugin({
        telemetry: false,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: 'hydro-dev',
        project: 'hydro-web',
        sourcemaps: {
          rewriteSources: (source) => source.replace('@hydrooj/ui-default/../../node_modules/', ''),
        },
        release: createSentryRelease ? {
          name: `hydro-web@${version}`,
          uploadLegacySourcemaps: root('public'),
        } : {},
      }),
      new webpack.DefinePlugin({
        'process.env.VERSION': JSON.stringify(require('@hydrooj/ui-default/package.json').version),
        ...(env.dev ? {} : {
          'module.hot': 'false',
          'module.hot.data': 'undefined',
        }),
      }),
      new webpack.optimize.MinChunkSizePlugin({
        minChunkSize: 128000,
      }),
      new webpack.NormalModuleReplacementPlugin(/\/(vscode-)?nls\.js/, require.resolve('../../components/monaco/nls')),
      new webpack.NormalModuleReplacementPlugin(/^prettier[$/]/, (resource) => {
        resource.request = resource.request === 'prettier/standalone'
          ? root('components/monaco/disabled-format.ts') : root('../../modules/nop.ts');
      }),
      new webpack.NormalModuleReplacementPlugin(/^highlightjs[$/]/, root('../../modules/nop.ts')),
      new webpack.NormalModuleReplacementPlugin(/core-js\/stable/, root('__core-js.js')),
      new MonacoWebpackPlugin({
        filename: '[name].[hash:6].worker.js',
        customLanguages: [{
          label: 'yaml',
          entry: require.resolve('monaco-yaml/index.js'),
          worker: {
            id: 'vs/language/yaml/yamlWorker',
            entry: require.resolve('monaco-yaml/yaml.worker.js'),
          },
        }],
      }),
      ...env.measure ? [
        new BundleAnalyzerPlugin({ analyzerPort: 'auto' }),
        new DuplicatesPlugin(),
      ] : [],
    ],
  };

  return config;
}
