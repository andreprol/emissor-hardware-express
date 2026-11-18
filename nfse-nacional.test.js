'use strict';

const { montarDPS, CNAE_PARA_CTN } = require('./nfse-nacional.cjs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const configEmpresaBase = { cnpj: '61.864.221/0001-00' };

function dadosBase(cnae) {
  return {
    naturezaOp: 'Prestação de Serviço',
    infAdicional: '',
    tomador: {
      doc: '123.456.789-00',
      nome: 'Cliente Teste',
      cep: '22410-002',
      logradouro: 'Rua Teste',
      numero: '1',
      bairro: 'Centro',
    },
    servico: {
      cnae,
      valor: '500.00',
      discriminacao: 'Serviço de teste',
      issRetido: '2',
      aliquotaIss: '5',
    },
  };
}

describe('montarDPS — mapeamento de CNAE pra código de serviço', () => {
  test('CNAE mapeado (suporte técnico, 6209100) monta DPS com cTribNac/cTribMun/cNBS corretos', () => {
    const { xml, dpsId } = montarDPS({ dados: dadosBase('6209100'), configEmpresa: configEmpresaBase, nDPS: 1, tpAmb: 2 });
    expect(dpsId).toHaveLength(45);
    expect(xml).toContain('<cTribNac>010701</cTribNac>');
    expect(xml).toContain('<cTribMun>001</cTribMun>');
    expect(xml).toContain('<cNBS>115013000</cNBS>');
  });

  test('CNAE sem mapeamento (consultoria TI, 6204000 — não está na tabela) bloqueia em vez de chutar código', () => {
    expect(CNAE_PARA_CTN['6204000']).toBeUndefined(); // confirma a premissa do teste
    expect(() => montarDPS({ dados: dadosBase('6204000'), configEmpresa: configEmpresaBase, nDPS: 2, tpAmb: 2 }))
      .toThrow(/CNAE 6204000 sem código de serviço.*mapeado/);
  });

  test('CNAE vazio também bloqueia, em vez de cair num código-padrão arbitrário', () => {
    expect(() => montarDPS({ dados: dadosBase(''), configEmpresa: configEmpresaBase, nDPS: 3, tpAmb: 2 }))
      .toThrow(/CNAE \(vazio\) sem código de serviço/);
  });
});
