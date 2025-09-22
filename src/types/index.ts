export interface PlayerStats {
    kills: number;
    deaths: number;
    assists?: number;
    matches?: number;
    [key: string]: any;
}