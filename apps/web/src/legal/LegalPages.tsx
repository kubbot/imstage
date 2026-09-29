/**
 * Bilingual terms of use and privacy / retention notices.
 *
 * Both documents describe what the product actually does since the 2026-09-30
 * safety change: synthetic chat authoring for tests and evaluation datasets,
 * a mandatory AI生成 / 虚构 disclosure on every preview and export, no payment
 * message capabilities, no real-screenshot reconstruction, a minimal hosted
 * generation audit with 90-day retention, and a non-commercial source license.
 */
import { useLocale } from '../marketing/LocaleContext';
import { BUSINESS_EMAIL, businessEmailAvailable } from '../config';

function ContactLine() {
  const { locale } = useLocale();
  if (businessEmailAvailable) {
    return (
      <p>
        {locale === 'zh' ? '数据集合作联系邮箱：' : 'Dataset enquiries: '}
        <a href={`mailto:${BUSINESS_EMAIL}`}>{BUSINESS_EMAIL}</a>
      </p>
    );
  }
  return (
    <p>
      {locale === 'zh'
        ? '数据集合作联系邮箱：暂未公布。'
        : 'Dataset enquiries: not published yet.'}
    </p>
  );
}

export function Terms() {
  const { locale } = useLocale();
  return (
    <div className="section-shell">
      <div className="page-intro">
        <span className="section-label">{locale === 'zh' ? '使用条款' : 'Terms of use'}</span>
        <h1>{locale === 'zh' ? '只做合成内容，只用于测试与学习。' : 'Synthetic content. Testing and learning only.'}</h1>
        <p>
          {locale === 'zh'
            ? 'IMStage 用于创作合成（虚构）聊天场景，服务于测试、教学与评测数据集标注。使用本产品即表示接受以下条款。'
            : 'IMStage authors synthetic (fictional) chat scenes for testing, teaching and evaluation dataset annotations. Using the product means accepting these terms.'}
        </p>
      </div>
      <div className="docs-layout">
        <div className="docs-content">
          <h2>{locale === 'zh' ? '1. 允许的用途' : '1. Permitted use'}</h2>
          <p>
            {locale === 'zh'
              ? '仅限测试、学习、研究与非商业用途，例如软件测试样本、教学示例、评测数据集与标注素材。本公开工具不可用于任何商业用途。'
              : 'Testing, learning, research and other non-commercial use only — for example software test fixtures, teaching examples, evaluation datasets and annotation material. Commercial use of this public tool is prohibited.'}
          </p>
          <h2>{locale === 'zh' ? '2. 禁止的用途' : '2. Prohibited use'}</h2>
          <ul className="doc-steps">
            <li><strong>{locale === 'zh' ? '伪造证据' : 'Fabricating evidence'}</strong><p>{locale === 'zh' ? '不得将生成画面作为真实聊天、交易、承诺或行为的证据。' : 'Never present generated frames as evidence of a real conversation, transaction, promise or act.'}</p></li>
            <li><strong>{locale === 'zh' ? '欺诈与误导' : 'Fraud and deception'}</strong><p>{locale === 'zh' ? '不得用于欺诈、虚假宣传、误导他人或规避法律义务。' : 'No fraud, false advertising, misleading others or evading legal obligations.'}</p></li>
            <li><strong>{locale === 'zh' ? '诽谤与冒充' : 'Defamation and impersonation'}</strong><p>{locale === 'zh' ? '不得诽谤他人，不得冒充真实个人、企业或机构。' : 'No defamation and no impersonation of real people, companies or institutions.'}</p></li>
            <li><strong>{locale === 'zh' ? '移除标识' : 'Removing the label'}</strong><p>{locale === 'zh' ? '不得移除、遮盖或淡化「AI生成 / 虚构」标识；该标识在所有预览与导出中强制显示。' : 'Never remove, obscure or dilute the “AI生成 / 虚构” (AI-generated / Fictional) label; it is mandatory on every preview and export.'}</p></li>
            <li><strong>{locale === 'zh' ? '真实截图仿制' : 'Real-screenshot forgery'}</strong><p>{locale === 'zh' ? '不得重建或仿制真实聊天截图；相关功能已停用，不得绕过。' : 'Do not rebuild or imitate real chat screenshots; that capability is disabled and must not be bypassed.'}</p></li>
            <li><strong>{locale === 'zh' ? '支付类内容' : 'Payment content'}</strong><p>{locale === 'zh' ? '支付、转账、红包、余额类消息能力已移除，不得以任何形式重建。' : 'Payment, transfer, red-packet and balance message capabilities are removed and must not be recreated in any form.'}</p></li>
          </ul>
          <h2>{locale === 'zh' ? '3. 生成内容' : '3. Generated content'}</h2>
          <p>
            {locale === 'zh'
              ? '所有输出画面都是为测试、教学与评测标注生成的合成内容，不证明任何真实人物说过或做过什么，也不得作为真实对话或行为的证据。人物、头像、时间与地点可以是虚构素材，也可以是你有权使用的真实素材（例如授权头像、真实地名）；你须确保所用素材是虚构的或已获授权。界面渲染为通用 IMStage 聊天样式，与任何聊天平台无隶属关系，不使用其商标或界面克隆。'
              : 'All output is synthetic content produced for testing, teaching and evaluation annotations. It proves nothing that any real person said or did and must never be used as evidence of a real conversation or act. People, avatars, times and places may be fictional or real material you are authorised to use (for example an authorised avatar or a real place name); you must ensure assets are fictional or properly authorised. The UI renders as the generic IMStage chat style; it is independent of any messaging platform and uses no trademarks or interface clones.'}
          </p>
          <h2>{locale === 'zh' ? '4. 许可与商业授权' : '4. License and commercial licensing'}</h2>
          <p>
            {locale === 'zh'
              ? '源代码采用非商业的“源码可得”许可（见仓库 LICENSE）；历史版本按 LICENSE-MIT-LEGACY 保留原 MIT 条款。本产品不是 OSI 认证的开源软件，也不存在对历史许可的追溯撤销。另行提供的闭源测试集、Evaluation 数据集与标注服务，按独立商业协议约定，不属于本公开工具的许可范围。'
              : 'The source code is available under a non-commercial source-available license (see LICENSE in the repository); earlier releases keep their original MIT terms via LICENSE-MIT-LEGACY. This is not OSI-approved open source, and nothing retroactively revokes the historical license. Separately offered closed-source test sets, evaluation datasets and annotation services are governed by independent commercial agreements, outside this public tool’s license.'}
          </p>
          <ContactLine />
          <h2>{locale === 'zh' ? '5. 免责声明' : '5. Disclaimer'}</h2>
          <p>
            {locale === 'zh'
              ? '产品按“现状”提供。使用者对生成内容的使用方式自行负责；违反条款造成的后果由使用者承担。'
              : 'The product is provided “as is”. Users are responsible for how they use generated content and bear the consequences of violating these terms.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export function Privacy() {
  const { locale } = useLocale();
  return (
    <div className="section-shell">
      <div className="page-intro">
        <span className="section-label">{locale === 'zh' ? '隐私与留存' : 'Privacy & retention'}</span>
        <h1>{locale === 'zh' ? '数据去了哪里，留了多久。' : 'Where data goes, and for how long.'}</h1>
        <p>
          {locale === 'zh'
            ? '这里只陈述产品当前真实的行为与边界，包括本地匿名编辑无法被服务端审计这一事实。'
            : 'This states only what the product actually does today — including the fact that anonymous local editing cannot be audited on any server.'}
        </p>
      </div>
      <div className="docs-layout">
        <div className="docs-content">
          <h2>{locale === 'zh' ? '1. 匿名本地编辑与导出' : '1. Anonymous local editing and export'}</h2>
          <p>
            {locale === 'zh'
              ? '免登录的编辑与 PNG 导出不会把场景内容或导出图片上传到服务器（页面本身仍会加载静态资源，服务器仍保留常规访问日志），服务端也不会为这些操作生成审计记录。精确局限：本地行为无法在服务端审计或追踪；相应地，「AI生成 / 虚构」标识在渲染器内强制绘制，随每张导出图片携带。'
              : 'Editing and PNG export without an account never upload scene contents or exported images to a server (the page itself still loads static assets and the server keeps ordinary access logs), and no server audit record is created for these actions. Precise limitation: local actions cannot be audited or traced server-side; instead the “AI生成 / 虚构” label is drawn by the renderer itself and travels with every exported image.'}
          </p>
          <h2>{locale === 'zh' ? '2. 账号数据' : '2. Account data'}</h2>
          <p>
            {locale === 'zh'
              ? '注册需要邮箱与密码。登录后保存的作品、项目、项目规则、批量提示词、人物库与偏好按账号隔离存储——这些是运营数据，与下述最小化审计是两回事。当前未实现邮箱验证、邮箱找回与第三方登录。删除作品会同时删除该作品存储的图片素材；但人物库、模板、已缓存的渲染图以及运维备份中的副本不受影响（部署侧备份按自身策略保留 14 个版本）。'
              : 'Registration needs an email and password. Saved scenes, projects, project rules, batch prompts, contact libraries and preferences are operational data stored per account — separate from the minimal audit below. Email verification, email recovery and third-party sign-in are not implemented. Deleting a scene also deletes that scene’s stored image assets; contact libraries, templates, cached renders and copies inside operational backups are unaffected (the deploy-side backup keeps 14 versions under its own policy).'}
          </p>
          <h2>{locale === 'zh' ? '3. 托管生成审计（90 天）' : '3. Hosted generation audit (90 days)'}</h2>
          <p>
            {locale === 'zh'
              ? '每一次托管生成（网页 Agent、项目批量、头像生成、MCP 保存的 AI 内容与托管渲染输出）都会写入一条持久审计记录，仅包含：运行 id、时间、账号 id、运行类型、策略版本、状态、内容摘要与错误码。审计绝不包含提示词原文、截图、图片或令牌；哈希是规范化场景 JSON 或渲染图片的 SHA-256 摘要，本身不保存任何原文内容。'
              : 'Every hosted generation (web Agent, project batches, portrait generation, AI-supplied content saved through MCP, hosted render outputs) writes one durable audit record containing only: run id, time, account id, flow, policy version, status, content digest and error code. The audit never contains raw prompts, screenshots, images or tokens; the hash is a SHA-256 digest of canonical scene JSON or a rendered image and stores no raw content itself.'}
          </p>
          <p>
            {locale === 'zh'
              ? '审计记录的主保留期为 90 天，到期由周期性运行的清理任务删除（服务启动时及此后每隔数小时执行，最长约 6 小时延迟），不做匿名化后再留存。运维备份另有自己的保留策略（当前为 14 个备份版本），因此并非所有副本都会在第 90 天消失。'
              : 'The primary retention for audit rows is 90 days, after which a periodically running cleanup job deletes them (at server start and then every few hours, up to about 6 hours late). Rows are not anonymised and kept beyond that window. Operational backups follow their own retention policy (currently 14 backup versions), so not every copy disappears exactly on day 90.'}
          </p>
          <h2>{locale === 'zh' ? '4. 模型服务商' : '4. Model providers'}</h2>
          <p>
            {locale === 'zh'
              ? '发起 AI 请求时，提示词、当前场景与你附加的图片会发送到服务端配置的模型与图片服务。密钥只保存在服务端。真实截图参考编辑已停用，不再提供“重建真实截图”的流程；但这不保证任意上传图片的像素内容本身不可能是一张截图——请只上传虚构素材或已获授权的素材。'
              : 'When you run an AI request, the prompt, current scene and any images you attached are sent to the model and image services configured on the server. Credentials stay server-side. Real-screenshot reference editing is disabled and no “rebuild a real screenshot” workflow is offered; this does not guarantee that arbitrary uploaded pixels could not themselves be a screenshot — upload only fictional or properly authorised material.'}
          </p>
          <h2>{locale === 'zh' ? '5. 联系方式' : '5. Contact'}</h2>
          <ContactLine />
        </div>
      </div>
    </div>
  );
}
