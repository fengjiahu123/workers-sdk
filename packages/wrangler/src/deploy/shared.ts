import {
	configFileName,
	getCIGeneratePreviewAlias,
	getCIOverrideName,
	getTodaysCompatDate,
	UserError,
} from "@cloudflare/workers-utils";
import { getAssetsOptions, validateAssetsArgsAndConfig } from "../assets";
import { getEntry } from "../deployment-bundle/entry";
import { logger } from "../logger";
import { getSiteAssetPaths } from "../sites";
import { requireAuth } from "../user";
import { collectKeyValues } from "../utils/collectKeyValues";
import { getRules } from "../utils/getRules";
import { getScriptName } from "../utils/getScriptName";
import { useServiceEnvironments as resolveUseServiceEnvironments } from "../utils/useServiceEnvironments";
import type { AssetsOptions } from "../assets";
import type { Entry } from "../deployment-bundle/entry";
import type { LegacyAssetPaths } from "../sites";
import type { versionsUploadCommand } from "../versions/upload";
import type { deployCommand } from "./index";
import type { Config, Route } from "@cloudflare/workers-utils";

/**
 * Shared arg validation for both `wrangler deploy` and `wrangler versions upload`.
 * Called from each command's `validateArgs` hook (before config is read).
 */
export function validateArgs(args: {
	nodeCompat: boolean | undefined;
	latest: boolean | undefined;
	config: string | undefined;
}): void {
	if (args.nodeCompat) {
		throw new UserError(
			"The --node-compat flag is no longer supported as of Wrangler v4. Instead, use the `nodejs_compat` compatibility flag. This includes the functionality from legacy `node_compat` polyfills and natively implemented Node.js APIs. See https://developers.cloudflare.com/workers/runtime-apis/nodejs for more information.",
			{ telemetryMessage: "deploy node compat unsupported" }
		);
	}

	if (args.latest) {
		logger.warn(
			`Using the latest version of the Workers runtime. To silence this warning, please choose a specific version of the runtime with --compatibility-date, or add a compatibility_date to your ${configFileName(args.config)} file.`
		);
	}
}

/**
 * Shared fields produced by merging CLI args with wrangler config.
 * After this point, no raw config/arg merging should happen.
 */
export type SharedUploadProps = {
	config: Config;
	accountId: string | undefined;
	/** Merged from args.script/config.main/config.site.entry-point/config.assets. */
	entry: Entry;
	/** From config.rules. */
	rules: Config["rules"];
	/** Merged: --name arg ?? config.name, with CI override applied. */
	name: string;
	workerNameOverridden: boolean;
	/** CLI-only (-e/--env). Selects a named environment from config. */
	env: string | undefined;
	/** Merged: --compatibility-date arg ?? config.compatibility_date. Still optional — validated as required in stage 4. */
	compatibilityDate: string | undefined;
	/** Merged: --compatibility-flags arg ?? config.compatibility_flags. */
	compatibilityFlags: string[];
	/** Merged from --assets arg and config.assets. */
	assetsOptions: AssetsOptions | undefined;
	/** Merged: --jsx-factory arg || config.jsx_factory. */
	jsxFactory: string;
	/** Merged: --jsx-fragment arg || config.jsx_fragment. */
	jsxFragment: string;
	/** Merged: --tsconfig arg ?? config.tsconfig. */
	tsconfig: string | undefined;
	/** Merged: --minify arg ?? config.minify. */
	minify: boolean | undefined;
	/** Merged: !(--bundle arg ?? !config.no_bundle). */
	noBundle: boolean;
	/** Merged: --upload-source-maps arg ?? config.upload_source_maps. */
	uploadSourceMaps: boolean | undefined;
	/** Merged: --keep-vars arg || config.keep_vars. */
	keepVars: boolean;
	/** Merged from --site arg and config.site. */
	isWorkersSite: boolean;
	/** CLI-only (--outdir). */
	outDir: string | undefined;
	/** CLI-only (--outfile). */
	outFile: string | undefined;
	/** CLI-only (--dry-run). */
	dryRun: boolean | undefined;
	/** Derived from entry resolution. */
	projectRoot: string;
	/** CLI-only (--experimental-auto-create). */
	experimentalAutoCreate: boolean;
	/** CLI-only (--tag). Version annotation. */
	tag: string | undefined;
	/** CLI-only (--message). Version annotation. */
	message: string | undefined;
	/** CLI-only (--secrets-file). */
	secretsFile: string | undefined;
	/** CLI-only (--var). */
	vars: Record<string, string>;
	/** Merged: { ...config.define, ...--define arg }. CLI overrides config. */
	defines: Record<string, string>;
	/** Merged: { ...config.alias, ...--alias arg }. CLI overrides config. */
	alias: Record<string, string>;
	/** Derived from config.legacy_env. */
	useServiceEnvironments: boolean;
};

export type DeployProps = SharedUploadProps & {
	/** Merged from --site arg and config.site. */
	legacyAssetPaths: LegacyAssetPaths | undefined;
	/** Merged: --triggers arg ?? config.triggers.crons. */
	triggers: string[] | undefined;
	/** Merged: --routes arg ?? config.routes ?? config.route. */
	routes: Route[];
	/** CLI-only (--domain). Converted to custom_domain route objects in deploy(). */
	domains: string[] | undefined;
	/** Merged: --logpush arg ?? config.logpush. */
	logpush: boolean | undefined;
	/** CLI-only (--old-asset-ttl). */
	oldAssetTtl: number | undefined;
	/** CLI-only (--dispatch-namespace). Workers for Platforms deployment target. */
	dispatchNamespace: string | undefined;
	/** CLI-only (--metafile). esbuild metafile output path. */
	metafile: string | boolean | undefined;
	/** CLI-only (--containers-rollout). */
	containersRollout: "immediate" | "gradual" | undefined;
	/** CLI-only (--strict). Enables strict mode for deploy confirmations. */
	strict: boolean | undefined;
};

export type VersionsUploadProps = SharedUploadProps & {
	/** CLI-only (--preview-alias), or auto-generated from CI branch name. */
	previewAlias: string | undefined;
};

type SharedMergeArgs =
	| (typeof deployCommand)["args"]
	| (typeof versionsUploadCommand)["args"];

async function mergeSharedConfigAndArgs(
	config: Config,
	args: SharedMergeArgs,
	command: "deploy" | "versions upload"
): Promise<SharedUploadProps> {
	validateAssetsArgsAndConfig(args, config);

	const entry = await getEntry(args, config, command);
	const assetsOptions = getAssetsOptions({ args, config });

	let name = getScriptName(args, config);
	let workerNameOverridden = false;

	const ciOverrideName = getCIOverrideName();
	if (ciOverrideName !== undefined && ciOverrideName !== name) {
		logger.warn(
			`Failed to match Worker name. Your config file is using the Worker name "${name}", but the CI system expected "${ciOverrideName}". Overriding using the CI provided Worker name. Workers Builds connected builds will attempt to open a pull request to resolve this config name mismatch.`
		);
		name = ciOverrideName;
		workerNameOverridden = true;
	}

	if (!name) {
		throw new UserError(
			'You need to provide a name of your worker. Either pass it as a cli arg with `--name <name>` or in your config file as `name = "<name>"`',
			{ telemetryMessage: true }
		);
	}

	const accountId = args.dryRun ? undefined : await requireAuth(config);

	const compatibilityDate = args.latest
		? getTodaysCompatDate()
		: (args.compatibilityDate ?? config.compatibility_date);

	return {
		config,
		accountId,
		entry,
		rules: getRules(config),
		name,
		workerNameOverridden,
		env: args.env,
		compatibilityDate,
		compatibilityFlags: args.compatibilityFlags ?? config.compatibility_flags,
		assetsOptions,
		jsxFactory: args.jsxFactory || config.jsx_factory,
		jsxFragment: args.jsxFragment || config.jsx_fragment,
		tsconfig: args.tsconfig ?? config.tsconfig,
		minify: args.minify ?? config.minify,
		noBundle: !(args.bundle ?? !config.no_bundle),
		uploadSourceMaps: args.uploadSourceMaps ?? config.upload_source_maps,
		keepVars:
			("keepVars" in args && Boolean(args.keepVars)) ||
			config.keep_vars ||
			false,
		isWorkersSite: Boolean(args.site || config.site),
		outDir: args.outdir,
		outFile: args.outfile,
		dryRun: args.dryRun,
		projectRoot: entry.projectRoot,
		experimentalAutoCreate: args.experimentalAutoCreate,
		tag: args.tag,
		message: args.message,
		secretsFile: args.secretsFile,
		vars: collectKeyValues(args.var),
		defines: { ...config.define, ...collectKeyValues(args.define) },
		alias: { ...config.alias, ...collectKeyValues(args.alias) },
		useServiceEnvironments: resolveUseServiceEnvironments(config),
	};
}

export async function mergeDeployConfigAndArgs(
	config: Config,
	args: SharedMergeArgs & {
		triggers: string[] | undefined;
		routes: string[] | undefined;
		domains: string[] | undefined;
		logpush: boolean | undefined; // resolved: args.logpush ?? config.logpush
		oldAssetTtl: number | undefined;
		dispatchNamespace: string | undefined;
		metafile: string | boolean | undefined;
		containersRollout: "immediate" | "gradual" | undefined;
		strict: boolean | undefined;
		siteInclude: string[] | undefined;
		siteExclude: string[] | undefined;
	}
): Promise<DeployProps> {
	const shared = await mergeSharedConfigAndArgs(config, args, "deploy");

	const routes: Route[] =
		args.routes ?? config.routes ?? (config.route ? [config.route] : []);

	return {
		...shared,
		legacyAssetPaths: getSiteAssetPaths(
			config,
			args.site,
			args.siteInclude,
			args.siteExclude
		),
		triggers: args.triggers ?? config.triggers?.crons,
		routes,
		domains: args.domains,
		logpush: args.logpush ?? config.logpush,
		oldAssetTtl: args.oldAssetTtl,
		dispatchNamespace: args.dispatchNamespace,
		metafile: args.metafile,
		containersRollout: args.containersRollout,
		strict: args.strict,
	};
}

export async function mergeVersionsUploadConfigAndArgs(
	config: Config,
	args: SharedMergeArgs & {
		previewAlias: string | undefined;
	},
	generatePreviewAlias: (scriptName: string) => string | undefined
): Promise<VersionsUploadProps> {
	const shared = await mergeSharedConfigAndArgs(
		config,
		// versions upload passes site: undefined to validateAssetsArgsAndConfig
		{ ...args, site: undefined },
		"versions upload"
	);

	const previewAlias =
		args.previewAlias ??
		(getCIGeneratePreviewAlias() === "true"
			? generatePreviewAlias(shared.name)
			: undefined);

	return {
		...shared,
		previewAlias,
	};
}
