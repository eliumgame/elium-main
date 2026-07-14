; ============================================================================
; Elium v4 — Inno Setup Installer Script
; ============================================================================
; Produit un installeur Windows qui :
;   - Installe Elium dans Program Files
;   - Crée des raccourcis (Bureau + Menu Démarrer)
;   - Associe l'extension .elium
;   - Permet la désinstallation propre
;
; Pré-requis pour compiler :
;   1. Inno Setup 6+ (https://jrsoftware.org/isinfo.php)
;   2. Avoir exécuté build.bat pour préparer staging/
; ============================================================================

#define AppName "Elium"
#define AppVersion "4.0.0"
#define AppPublisher "Elium Authors"
#define AppURL "https://github.com/elium-project/elium"
#define AppExeName "Elium.exe"

[Setup]
AppId={{E1C8F4A2-3B7D-4E9F-A1C2-8D5F6E7A9B0C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=output
OutputBaseFilename=Elium-{#AppVersion}-Setup
SetupIconFile=..\brand\elium.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardImageFile=assets\wizard-large.bmp
WizardSmallImageFile=assets\wizard-small.bmp
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
UninstallDisplayIcon={app}\elium.ico

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "fileassoc"; Description: "Associer les fichiers .elium à Elium"; GroupDescription: "Association de fichiers:"

[Files]
; Icône de l'application (pour l'association .elium et la désinstallation)
Source: "..\brand\elium.ico"; DestDir: "{app}"; Flags: ignoreversion

; Application autonome (PyInstaller one-file : Python + crypto + Web Studio embarqués)
Source: "staging\Elium.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\elium.ico"; Comment: "Lancer Elium Web Studio"
Name: "{group}\Désinstaller {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\elium.ico"; Tasks: desktopicon; Comment: "Lancer Elium"

[Registry]
; Association de fichier .elium
Root: HKCR; Subkey: ".elium"; ValueType: string; ValueName: ""; ValueData: "EliumDocument"; Flags: uninsdeletevalue; Tasks: fileassoc
Root: HKCR; Subkey: "EliumDocument"; ValueType: string; ValueName: ""; ValueData: "Document Elium"; Flags: uninsdeletekey; Tasks: fileassoc
Root: HKCR; Subkey: "EliumDocument\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\elium.ico,0"; Tasks: fileassoc
Root: HKCR; Subkey: "EliumDocument\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: fileassoc

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
  // Vérifications supplémentaires si nécessaire
end;
