// MobilMotor kurulum programı. Yönetici izni istemez; kullanıcı klasörüne kurar.
// Akış: 1) kurulacakların özeti  2) "Bilgisayarı kontrol et"  3) onayla kur.
// Derleme: build\paketle.ps1 (paket, kaynak olarak exe'nin içine gömülür)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("MobilMotor Kurulum")]
[assembly: AssemblyProduct("MobilMotor")]
[assembly: AssemblyDescription("MobilMotor kurulum programı")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Kurulum
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch (Exception) { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // Pencere açmadan test/otomasyon seçenekleri:
        //   --ekran-goruntusu <png>   kurulum ekranını (kontrol yapılmış haliyle) görünmez çizip kaydeder
        //   --kontrol-rapor <txt>     bilgisayar kontrolünün sonuçlarını dosyaya yazar
        //   --sessiz-kur <klasör>     arayüzsüz kurar (kısayol ve açılış kaydı olmadan)
        string shot = Arg(args, "--ekran-goruntusu"), report = Arg(args, "--kontrol-rapor"), silent = Arg(args, "--sessiz-kur");
        if (shot != null || report != null || silent != null)
        {
            var f = new SetupForm();
            try
            {
                if (silent != null) { f.SilentInstall(silent); return 0; }
                f.RunChecksForTest();
                if (report != null) File.WriteAllText(report, f.ReportText(), System.Text.Encoding.UTF8);
                if (shot != null)
                {
                    // Tamamen saydam, görev çubuğunda yok, ekran dışında: kullanıcı hiçbir şey görmez
                    f.Opacity = 0;
                    f.ShowInTaskbar = false;
                    f.StartPosition = FormStartPosition.Manual;
                    f.Location = new Point(-10000, -10000);
                    f.Show();
                    Application.DoEvents();
                    using (var bmp = new Bitmap(f.ClientSize.Width, f.ClientSize.Height))
                    {
                        f.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                        bmp.Save(shot, System.Drawing.Imaging.ImageFormat.Png);
                    }
                }
                return 0;
            }
            catch (Exception e)
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "mobilmotor-kurulum-hata.txt"), e.ToString());
                return 1;
            }
        }
        Application.Run(new SetupForm());
        return 0;
    }

    static string Arg(string[] a, string k)
    {
        int i = Array.IndexOf(a, k);
        return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
    }
}

class Check
{
    public string Level; // ok, warn, bad, info
    public string Title;
    public string Detail;
    public Check(string level, string title, string detail) { Level = level; Title = title; Detail = detail; }
}

class SetupForm : Form
{
    static readonly Color Bg = Color.FromArgb(17, 18, 20);
    static readonly Color Panel = Color.FromArgb(26, 27, 30);
    static readonly Color Line = Color.FromArgb(43, 44, 48);
    static readonly Color Ink = Color.FromArgb(232, 229, 222);
    static readonly Color Muted = Color.FromArgb(140, 137, 130);
    static readonly Color Accent = Color.FromArgb(255, 106, 43);
    static readonly Color Ok = Color.FromArgb(61, 220, 132);
    static readonly Color Warn = Color.FromArgb(240, 180, 41);
    static readonly Color Bad = Color.FromArgb(255, 90, 82);

    const string Version = "1.0.0";
    TextBox pathBox;
    CheckBox cbDesktop, cbStart, cbAutorun, cbLaunch;
    Button btnCheck, btnInstall, btnBrowse;
    FlowLayoutPanel checkList;
    ProgressBar bar;
    Label status;
    bool checkedOnce, hasBlocker;

    public SetupForm()
    {
        Text = "MobilMotor Kurulumu";
        BackColor = Bg;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 9.5f);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(760, 740);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

        var title = new Label { Text = "MOBİLMOTOR", Font = new Font("Cascadia Mono", 15f, FontStyle.Bold), ForeColor = Ink, AutoSize = true, Location = new Point(28, 22) };
        var sub = new Label { Text = "Android telefon, tablet ve emülatörlerini bu bilgisayardan yönet. Her şey yerelde kalır.", ForeColor = Muted, AutoSize = true, Location = new Point(30, 56) };
        Controls.Add(title);
        Controls.Add(sub);

        // 1) Kurulacaklar
        Controls.Add(Heading("1  KURULACAKLAR", 92));
        var items = new[] {
            new[] { "MobilMotor paneli ve başlatıcı", "~1 MB", "Tarayıcıda açılan kontrol paneli, görev çubuğu simgesi" },
            new[] { "Node.js çalışma ortamı (v24)", "~85 MB", "Panel sunucusu için; OpenJS Foundation imzalı" },
            new[] { "Android adb (Google platform-tools)", "~10 MB", "Telefon ve emülatörlerle konuşmak için" },
            new[] { "scrcpy 4.1", "~10 MB", "Canlı ekran ve dokunma için; imzası doğrulanmış resmî sürüm" },
            new[] { "Sonra, isteğe bağlı: Android emülatörü + Android 15", "~2,2 GB", "Panelden tek tuşla, yalnızca Google'dan doğrulanarak indirilir" },
        };
        int y = 122;
        foreach (var it in items)
        {
            Controls.Add(new Label { Text = "•  " + it[0], ForeColor = it[0].StartsWith("Sonra") ? Muted : Ink, AutoSize = true, Location = new Point(34, y) });
            Controls.Add(new Label { Text = it[1], ForeColor = Accent, Font = new Font("Cascadia Mono", 9f), AutoSize = false, TextAlign = ContentAlignment.TopRight, Size = new Size(90, 20), Location = new Point(636, y) });
            Controls.Add(new Label { Text = it[2], ForeColor = Muted, Font = new Font("Segoe UI", 8.5f), AutoSize = true, Location = new Point(50, y + 19) });
            y += 42;
        }

        Controls.Add(new Label { Text = "Konum", ForeColor = Muted, AutoSize = true, Location = new Point(34, y + 6) });
        pathBox = new TextBox { Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "MobilMotor"), Location = new Point(92, y + 2), Size = new Size(530, 26), BackColor = Panel, ForeColor = Ink, BorderStyle = BorderStyle.FixedSingle };
        btnBrowse = MakeButton("Değiştir…", new Point(632, y), new Size(94, 30), false);
        btnBrowse.Click += delegate
        {
            using (var d = new FolderBrowserDialog { Description = "MobilMotor'un kurulacağı klasör" })
                if (d.ShowDialog(this) == DialogResult.OK) { pathBox.Text = Path.Combine(d.SelectedPath, "MobilMotor"); checkedOnce = false; UpdateButtons(); }
        };
        pathBox.TextChanged += delegate { checkedOnce = false; UpdateButtons(); };
        Controls.Add(pathBox);
        Controls.Add(btnBrowse);
        y += 40;
        cbDesktop = MakeCheck("Masaüstü kısayolu", new Point(34, y), true);
        cbStart = MakeCheck("Başlat menüsü", new Point(210, y), true);
        cbAutorun = MakeCheck("Windows açılışında sessizce başlat", new Point(360, y), false);
        y += 30;
        cbLaunch = MakeCheck("Kurulumdan sonra aç", new Point(34, y), true);

        // 2) Kontrol
        y += 40;
        Controls.Add(Heading("2  BİLGİSAYAR KONTROLÜ", y));
        btnCheck = MakeButton("Bilgisayarı kontrol et", new Point(560, y - 6), new Size(166, 30), false);
        btnCheck.Click += delegate { RunChecks(); };
        Controls.Add(btnCheck);
        checkList = new FlowLayoutPanel { Location = new Point(28, y + 30), Size = new Size(704, 150), AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Panel };
        checkList.Controls.Add(new Label { Text = "Kurmadan önce bu bilgisayarda eksik bir şey var mı bakalım.", ForeColor = Muted, AutoSize = true, Margin = new Padding(10, 10, 0, 0) });
        Controls.Add(checkList);

        // 3) Kur
        y += 196;
        bar = new ProgressBar { Location = new Point(28, y + 6), Size = new Size(520, 10), Visible = false };
        status = new Label { Text = "", ForeColor = Muted, AutoSize = true, Location = new Point(28, y + 22) };
        btnInstall = MakeButton("Onaylıyorum, kur", new Point(560, y - 4), new Size(166, 36), true);
        btnInstall.Click += delegate { Install(); };
        Controls.Add(bar);
        Controls.Add(status);
        Controls.Add(btnInstall);
        UpdateButtons();
        Shown += delegate { btnCheck.Focus(); pathBox.SelectionLength = 0; };
    }

    Label Heading(string text, int y)
    {
        return new Label { Text = text, ForeColor = Muted, Font = new Font("Cascadia Mono", 8.5f, FontStyle.Bold), AutoSize = true, Location = new Point(30, y) };
    }

    Button MakeButton(string text, Point at, Size size, bool primary)
    {
        var b = new Button { Text = text, Location = at, Size = size, FlatStyle = FlatStyle.Flat, BackColor = primary ? Accent : Panel, ForeColor = primary ? Color.FromArgb(18, 10, 6) : Ink, Cursor = Cursors.Hand };
        b.FlatAppearance.BorderColor = primary ? Accent : Line;
        if (primary) b.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
        return b;
    }

    CheckBox MakeCheck(string text, Point at, bool on)
    {
        var c = new CheckBox { Text = text, Checked = on, AutoSize = true, Location = at, ForeColor = Ink };
        Controls.Add(c);
        return c;
    }

    void UpdateButtons()
    {
        btnInstall.Enabled = checkedOnce && !hasBlocker;
        btnInstall.BackColor = btnInstall.Enabled ? Accent : Line;
        if (!checkedOnce) status.Text = "Kurmak için önce \"Bilgisayarı kontrol et\".";
    }

    // ---------------- Test yardımcıları ----------------
    List<Check> lastChecks = new List<Check>();
    public void RunChecksForTest() { RunChecks(); }
    public string ReportText()
    {
        var sb = new System.Text.StringBuilder();
        foreach (var c in lastChecks) sb.AppendLine("[" + c.Level + "] " + c.Title + " — " + c.Detail);
        sb.AppendLine("Kur düğmesi: " + (btnInstall.Enabled ? "etkin" : "kapalı") + " | " + status.Text);
        return sb.ToString();
    }
    public void SilentInstall(string target)
    {
        pathBox.Text = target;
        RunChecks();
        if (hasBlocker) throw new Exception("Engelleyici sorun var:\n" + ReportText());
        DoInstall(Path.GetFullPath(target), false, false, false, false);
    }

    // ---------------- Kontroller ----------------
    void RunChecks()
    {
        var list = new List<Check>();
        try { list = Checks(); }
        catch (Exception e) { list.Add(new Check("warn", "Kontrol tamamlanamadı", e.Message)); }
        lastChecks = list;
        checkList.Controls.Clear();
        hasBlocker = false;
        foreach (var c in list)
        {
            if (c.Level == "bad") hasBlocker = true;
            var row = new Panel { Width = 680, Height = c.Detail.Length > 90 ? 50 : 38, Margin = new Padding(6, 4, 0, 0) };
            Color dot = c.Level == "ok" ? Ok : c.Level == "warn" ? Warn : c.Level == "bad" ? Bad : Muted;
            row.Controls.Add(new Label { Text = "●", ForeColor = dot, AutoSize = true, Location = new Point(4, 0) });
            row.Controls.Add(new Label { Text = c.Title, ForeColor = Ink, Font = new Font("Segoe UI", 9.5f, FontStyle.Bold), AutoSize = true, Location = new Point(24, 0) });
            row.Controls.Add(new Label { Text = c.Detail, ForeColor = Muted, Font = new Font("Segoe UI", 8.5f), AutoSize = false, Size = new Size(650, row.Height - 18), Location = new Point(24, 18) });
            checkList.Controls.Add(row);
        }
        checkedOnce = true;
        UpdateButtons();
        int bad = 0, warn = 0;
        foreach (var c in list) { if (c.Level == "bad") bad++; if (c.Level == "warn") warn++; }
        status.Text = bad > 0 ? "Kırmızı işaretli sorunlar giderilmeden kurulum yapılamaz."
            : warn > 0 ? "Kurulabilir. Sarı işaretliler yalnızca bazı özellikleri etkiler."
            : "Her şey hazır. Onay verirsen kurulum başlar.";
    }

    List<Check> Checks()
    {
        var r = new List<Check>();
        var os = Environment.OSVersion.Version;
        bool win10 = os.Major >= 10;
        r.Add(!Environment.Is64BitOperatingSystem ? new Check("bad", "Windows 64 bit değil", "MobilMotor 64 bit Windows 10/11 gerektirir.")
            : !win10 ? new Check("bad", "Windows sürümü eski", "Windows 10 veya 11 gerekli.")
            : new Check("ok", "Windows " + (os.Build >= 22000 ? "11" : "10") + " (64 bit)", "Sürüm " + os));

        string target = pathBox.Text.Trim();
        try
        {
            string rootDrive = Path.GetPathRoot(Path.GetFullPath(target));
            long free = new DriveInfo(rootDrive).AvailableFreeSpace / (1024L * 1024 * 1024);
            r.Add(free < 1 ? new Check("bad", "Disk dolu (" + rootDrive + ")", "Kurulum için en az 1 GB boş alan gerekli; şu an " + free + " GB.")
                : free < 8 ? new Check("warn", "Disk alanı az: " + free + " GB boş", "Panel kurulur; emülatör bileşenleri ve sanal cihazlar için ~8 GB önerilir.")
                : new Check("ok", "Boş disk: " + free + " GB", rootDrive));
        }
        catch (Exception) { r.Add(new Check("bad", "Kurulum konumu geçersiz", target)); }

        double ramGb = 0;
        bool hyper = false, vtFirmware = false;
        foreach (ManagementObject o in new ManagementObjectSearcher("SELECT TotalPhysicalMemory, HypervisorPresent FROM Win32_ComputerSystem").Get())
        {
            ramGb = Convert.ToDouble(o["TotalPhysicalMemory"]) / (1024 * 1024 * 1024);
            hyper = o["HypervisorPresent"] != null && (bool)o["HypervisorPresent"];
        }
        foreach (ManagementObject o in new ManagementObjectSearcher("SELECT VirtualizationFirmwareEnabled FROM Win32_Processor").Get())
            vtFirmware = o["VirtualizationFirmwareEnabled"] != null && (bool)o["VirtualizationFirmwareEnabled"];
        int ram = (int)Math.Round(ramGb);
        r.Add(ram < 4 ? new Check("warn", "RAM: " + ram + " GB", "Telefon kontrolü çalışır; emülatör için en az 8 GB önerilir.")
            : ram < 8 ? new Check("warn", "RAM: " + ram + " GB", "Aynı anda 1 emülatör rahat çalışır.")
            : new Check("ok", "RAM: " + ram + " GB", "Aynı anda yaklaşık " + Math.Max(1, Math.Min((ram - 6) / 3, Environment.ProcessorCount / 2)) + " emülatör rahat çalışır (" + Environment.ProcessorCount + " iş parçacıklı işlemci)."));

        r.Add(hyper ? new Check("ok", "Donanım sanallaştırma açık", "Emülatörler hızlandırmalı çalışır (Windows Hipervizör).")
            : vtFirmware ? new Check("warn", "Windows Hipervizör Platformu kapalı", "Yalnızca emülatörü etkiler. Başlat › \"Windows özelliklerini aç veya kapat\" › \"Windows Hiper Yönetici Platformu\" işaretle ve yeniden başlat (yönetici izni ister).")
            : new Check("warn", "Sanallaştırma BIOS'ta kapalı", "Yalnızca emülatörü etkiler. BIOS/UEFI'de Intel VT-x veya AMD SVM'yi aç, sonra Windows Hiper Yönetici Platformu'nu etkinleştir."));

        string sdk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Android", "Sdk");
        bool hasSdk = File.Exists(Path.Combine(sdk, "platform-tools", "adb.exe"));
        bool hasEmu = File.Exists(Path.Combine(sdk, "emulator", "emulator.exe"));
        r.Add(hasSdk ? new Check("info", "Android Studio SDK bulundu", "Mevcut SDK kullanılacak" + (hasEmu ? " (emülatör dahil)." : "; emülatör yoksa panelden indirilebilir."))
            : new Check("info", "Android SDK yok", "Sorun değil: adb paketle gelir; emülatör istersen panelden indirilir."));

        bool browser = AppPath("msedge.exe") || AppPath("chrome.exe");
        r.Add(browser ? new Check("ok", "Tarayıcı uygun (Edge/Chrome)", "Canlı ekran donanımla çözülür.")
            : new Check("warn", "Edge veya Chrome bulunamadı", "Canlı video için Edge ya da Chrome önerilir; diğerlerinde ekran görüntüsü moduna geçer."));

        if (File.Exists(Path.Combine(target, "kurulum.json")))
            r.Add(new Check("info", "Önceki kurulum bulundu", "Güncellenecek; makrolar, kayıtlar ve ayarlar (data klasörü) korunur."));
        else if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0)
            r.Add(new Check("bad", "Hedef klasör dolu", "Seçilen klasör boş değil ve MobilMotor kurulumu değil: " + target));

        string mine = Path.Combine(Path.GetFullPath(target), "MobilMotor.exe");
        foreach (Process p in Process.GetProcessesByName("MobilMotor"))
        {
            bool same = false;
            try { same = string.Equals(p.MainModule.FileName, mine, StringComparison.OrdinalIgnoreCase); } catch (Exception) { }
            if (same) { r.Add(new Check("warn", "MobilMotor şu an açık", "Güncelleme için kapatılıp kurulumdan sonra yeniden açılacak.")); break; }
        }

        r.Add(new Check("info", "Telefon bağlarken", "Telefonda Geliştirici seçenekleri › USB hata ayıklama açık olmalı. Samsung vb. için üreticinin USB sürücüsü gerekebilir."));
        return r;
    }

    static bool AppPath(string exe)
    {
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            using (var k = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                if (k != null) return true;
        return false;
    }

    // ---------------- Kurulum ----------------
    void Install()
    {
        string target = Path.GetFullPath(pathBox.Text.Trim());
        btnInstall.Enabled = btnCheck.Enabled = btnBrowse.Enabled = pathBox.Enabled = false;
        bar.Visible = true;
        bool desktop = cbDesktop.Checked, start = cbStart.Checked, autorun = cbAutorun.Checked, launch = cbLaunch.Checked;
        var t = new Thread(delegate ()
        {
            try
            {
                DoInstall(target, desktop, start, autorun);
                Invoke((MethodInvoker)delegate
                {
                    bar.Value = bar.Maximum;
                    status.ForeColor = Ok;
                    status.Text = "Kurulum tamamlandı: " + target;
                    btnInstall.Text = "Kapat";
                    btnInstall.Enabled = true;
                    btnInstall.BackColor = Accent;
                    btnInstall.Click += delegate { Close(); };
                    if (launch) Process.Start(Path.Combine(target, "MobilMotor.exe"));
                });
            }
            catch (Exception e)
            {
                Invoke((MethodInvoker)delegate
                {
                    status.ForeColor = Bad;
                    status.Text = "Kurulum başarısız: " + e.Message;
                    btnCheck.Enabled = btnBrowse.Enabled = pathBox.Enabled = true;
                });
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    void Say(string text, int value, int max)
    {
        if (!IsHandleCreated) return; // sessiz kurulum
        Invoke((MethodInvoker)delegate { status.ForeColor = Muted; status.Text = text; bar.Maximum = Math.Max(1, max); bar.Value = Math.Min(value, bar.Maximum); });
    }

    // system=false: sessiz test kurulumu (Denetim Masası kaydı, açılış kaydı, kısayol yok)
    void DoInstall(string target, bool desktop, bool start, bool autorun, bool system = true)
    {
        // Yalnızca BU klasörden çalışan MobilMotor'u kapat (sunucusu da stdin kapanınca kendini kapatır)
        string mine = Path.Combine(target, "MobilMotor.exe");
        foreach (Process p in Process.GetProcessesByName("MobilMotor"))
            try { if (string.Equals(p.MainModule.FileName, mine, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(5000); } } catch (Exception) { }
        Thread.Sleep(500);

        Directory.CreateDirectory(target);
        using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(res, ZipArchiveMode.Read))
        {
            int i = 0, n = zip.Entries.Count;
            string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                i++;
                // .NET Framework zip'leri "\" ayırıcı yazabilir: ikisini de tanı
                string name = e.FullName.Replace('\\', '/');
                string dest = Path.GetFullPath(Path.Combine(target, name.Replace('/', '\\')));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase) && dest.TrimEnd('\\') + "\\" != root) throw new Exception("Paket içinde geçersiz yol: " + e.FullName);
                if (name.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                // Kullanıcı verisi (data) güncellemede korunur
                if (name.StartsWith("data/", StringComparison.OrdinalIgnoreCase) && File.Exists(dest)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                if (i % 5 == 0 || i == n) Say("Dosyalar kopyalanıyor… " + e.FullName, i, n);
                e.ExtractToFile(dest, true);
            }
        }
        File.WriteAllText(Path.Combine(target, "kurulum.json"), "{\"surum\":\"" + Version + "\",\"tarih\":\"" + DateTime.Now.ToString("s") + "\"}");

        Say("Kısayollar oluşturuluyor…", 1, 1);
        string exe = Path.Combine(target, "MobilMotor.exe");
        if (desktop) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MobilMotor.lnk"), exe, target);
        if (start) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "MobilMotor.lnk"), exe, target);
        if (!system) return;

        using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\MobilMotor"))
        {
            k.SetValue("DisplayName", "MobilMotor");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "MobilMotor");
            k.SetValue("DisplayIcon", exe);
            k.SetValue("InstallLocation", target);
            k.SetValue("UninstallString", "\"" + exe + "\" --kaldir");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", 110 * 1024, RegistryValueKind.DWord);
        }
        using (var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
        {
            if (autorun) run.SetValue("MobilMotor", "\"" + exe + "\" --sessiz");
            else run.DeleteValue("MobilMotor", false);
        }
    }

    static void Shortcut(string lnk, string exe, string workdir)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { exe });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workdir });
        st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { exe + ",0" });
        st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "MobilMotor" });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        Marshal.FinalReleaseComObject(sc);
        Marshal.FinalReleaseComObject(shell);
    }
}
