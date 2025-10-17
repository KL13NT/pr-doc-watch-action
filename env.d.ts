declare namespace NodeJS {
	export interface ProcessEnv {
		GITHUB_TOKEN: string;
		GITHUB_REPOSITORY: string;
		ACTION_PATH: string;
		PR_NUMBER: string;
		GITHUB_SHA: string;
		GITHUB_EVENT_PATH: string;
	}
}
